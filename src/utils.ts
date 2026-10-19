import { USDC_DECIMALS } from './onchain-config'

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
