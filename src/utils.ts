import type { PublicClient, Abi } from 'viem'
import { BaseError, decodeErrorResult, decodeFunctionData } from 'viem'
import { MIN_BASE_FEE_GWEI } from './onchain-config'
import { USDC_DECIMALS } from './onchain-config'

const KNOWN_ERRORS = ['DUPLICATE_INTENT', 'INTENT_EXPIRED', 'OVER_BUDGET', 'NOT_PAYER'] as const

/**
 * Shared onchain revert decoder used by PayScreen and ActivityScreen.
 *
 * Decode order:
 *   (a) Walk the viem BaseError chain with .walk() to find the innermost
 *       error that carries `data` (ContractFunctionRevertedError /
 *       RawContractError) and ABI-decode with the vault ABI.
 *   (b) Scan the error message string for known error names.
 *   (c) Replay the tx calldata with eth_call at 'latest' — then ABI-decode
 *       the revert data from that call.
 *   (d) paidIntents(intentId) fallback: if the tx input is a pay() call,
 *       read paidIntents on-chain; if true → DUPLICATE_INTENT.
 *   (e) REVERTED — never FAILED.
 *
 * @param hash     Tx hash to decode (revert expected).
 * @param abi      Vault ABI (Abi type).
 * @param client   viem PublicClient for the target chain.
 * @param vault    Vault contract address (for paidIntents fallback).
 * @param apiReason Optional revert_reason string from Blockscout.
 */
export async function decodeOnchainRevert(
  hash: `0x${string}`,
  abi: Abi,
  client: PublicClient,
  vault: `0x${string}`,
  apiReason?: string | null,
): Promise<string> {
  // (a-pre) Explorer reason string
  if (apiReason) {
    for (const c of KNOWN_ERRORS) { if (apiReason.includes(c)) return c }
    if (apiReason.startsWith('0x')) {
      try { return decodeErrorResult({ abi, data: apiReason as `0x${string}` }).errorName } catch { /* fall */ }
    }
  }

  // Helper: extract revert data from a viem error via BaseError.walk()
  function extractRevertData(err: unknown): `0x${string}` | null {
    if (!(err instanceof BaseError)) return null
    // walk() finds the first matching node in the error chain
    const inner = err.walk(e => {
      const candidate = e as { data?: unknown }
      return typeof candidate.data === 'string' && candidate.data.startsWith('0x') && candidate.data.length > 2
    })
    if (!inner) return null
    const d = (inner as { data?: string }).data
    return (d && d.startsWith('0x') && d.length > 2) ? d as `0x${string}` : null
  }

  // Helper: decode an ABI error from raw 0x data
  function decodeAbiError(data: `0x${string}`): string | null {
    try { return decodeErrorResult({ abi, data }).errorName } catch { return null }
  }

  // Helper: scan error message for known names
  function scanMessage(err: unknown): string | null {
    const msg = (err as Error)?.message ?? String(err)
    for (const c of KNOWN_ERRORS) { if (msg.includes(c)) return c }
    return null
  }

  // (b+c) Replay with eth_call at 'latest'
  try {
    const tx = await client.getTransaction({ hash })
    await client.call({ to: tx.to ?? undefined, data: tx.input, account: tx.from })
    // No revert — state changed; fall through to paidIntents
  } catch (revertErr) {
    // (b) scan message
    const fromMsg = scanMessage(revertErr)
    if (fromMsg) return fromMsg

    // (a via walk) extract data from BaseError chain
    const data = extractRevertData(revertErr)
    if (data) {
      const decoded = decodeAbiError(data)
      if (decoded) return decoded
    }

    // (c) data on raw err object (some viem versions put it top-level)
    const rawData = (revertErr as { data?: `0x${string}` })?.data
    if (rawData && rawData !== '0x') {
      const decoded = decodeAbiError(rawData)
      if (decoded) return decoded
    }
  }

  // (d) paidIntents fallback
  try {
    const tx = await client.getTransaction({ hash })
    const decoded = decodeFunctionData({ abi, data: tx.input })
    if (decoded.functionName === 'pay') {
      const intentId = (decoded.args as [`0x${string}`, ...unknown[]])[0]
      const isPaid = await client.readContract({ address: vault, abi, functionName: 'paidIntents', args: [intentId] })
      if (isPaid) return 'DUPLICATE_INTENT'
    }
  } catch { /* leave as REVERTED */ }

  return 'REVERTED'
}

const ONE_GWEI = 1_000_000_000n
const MIN_BASE_FEE_WEI = MIN_BASE_FEE_GWEI * ONE_GWEI  // 20 gwei in wei

/** Result of getFeeParams — always fully populated, never a guess. */
export interface FeeParams {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/**
 * Fetch live EIP-1559 fee params from the chain with one automatic retry.
 *
 * Rules (per spec):
 *   - maxPriorityFeePerGas = max(estimated priority fee, 1 gwei)
 *   - maxFeePerGas         = max(estimated maxFeePerGas, MIN_BASE_FEE_WEI + priority)
 *
 * If both attempts fail, throws:
 *   "Couldn't get the network fee. Try again."
 * The caller must catch this and show it as a toast — never open the wallet.
 */
export async function getFeeParams(publicClient: PublicClient): Promise<FeeParams> {
  async function attempt(): Promise<FeeParams> {
    const fees = await publicClient.estimateFeesPerGas()

    // estimateFeesPerGas returns either EIP-1559 fields or a legacy gasPrice.
    // Normalise to EIP-1559.
    let estimatedMax: bigint
    let estimatedPriority: bigint

    if (fees.maxFeePerGas != null) {
      estimatedMax = fees.maxFeePerGas
      estimatedPriority = fees.maxPriorityFeePerGas ?? ONE_GWEI
    } else {
      // Legacy chain — treat gasPrice as both base and priority ceiling
      estimatedMax = fees.gasPrice ?? 0n
      estimatedPriority = ONE_GWEI
    }

    const priority = estimatedPriority > ONE_GWEI ? estimatedPriority : ONE_GWEI
    const floor = MIN_BASE_FEE_WEI + priority
    const max = estimatedMax > floor ? estimatedMax : floor

    return { maxFeePerGas: max, maxPriorityFeePerGas: priority }
  }

  try {
    return await attempt()
  } catch {
    // Retry once after 1 second
    await new Promise(r => setTimeout(r, 1000))
    try {
      return await attempt()
    } catch {
      throw new Error("Couldn't get the network fee. Try again.")
    }
  }
}

/** Format a raw USDC bigint (6 decimals) as "$0.00" string */
export function formatUsdc(raw: bigint | undefined, decimals = 2): string {
  if (raw === undefined) return '—'
  const n = Number(raw) / 10 ** USDC_DECIMALS
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/** Parse a user-entered USDC string (e.g. "1.50") to raw bigint */
export function parseUsdc(value: string): bigint {
  if (!value || value === '.') return 0n
  const [integer = '0', decimal = ''] = value.split('.')
  const padded = decimal.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS)
  return BigInt(integer) * BigInt(10 ** USDC_DECIMALS) + BigInt(padded)
}

export function formatAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

/** Extract a human-readable reason code from a contract revert */
export function parseRevertReason(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err)
  for (const code of ['DUPLICATE_INTENT', 'INTENT_EXPIRED', 'OVER_BUDGET', 'NOT_PAYER']) {
    if (msg.includes(code)) return code
  }
  if (msg.toLowerCase().includes('user rejected')) return 'CANCELLED'
  if (msg.toLowerCase().includes('insufficient')) return 'INSUFFICIENT_FUNDS'
  return 'REVERTED'
}
