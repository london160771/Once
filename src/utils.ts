import type { PublicClient } from 'viem'
import { MIN_BASE_FEE_GWEI } from './onchain-config'
import { USDC_DECIMALS } from './onchain-config'

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
  return 'FAILED'
}
