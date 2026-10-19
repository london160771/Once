/**
 * ActivityScreen — shows both successful pay() calls and failed/reverted ones.
 *
 * Primary data source: Blockscout API
 *   GET {EXPLORER_BASE}/api/v2/addresses/{VAULT_ADDRESS}/transactions
 * This returns every tx sent to the vault, including reverted ones, and
 * survives a page refresh because it reads from the chain.
 *
 * Fallback / in-memory layer: stormResults prop from PayScreen.
 * Used as an optimistic layer until the API returns, then deduped by tx hash.
 *
 * Revert reason decoding: we replay the call at its block via eth_call so we
 * can decode the custom error name from the ABI. If that fails we show REVERTED.
 */

import { useEffect, useState, useCallback } from 'react'
import { usePublicClient } from 'wagmi'
import { decodeErrorResult, decodeEventLog, type Log } from 'viem'
import {
  CheckCircle2, XCircle, ExternalLink, RefreshCw, Loader2,
  MinusCircle, AlertCircle,
} from 'lucide-react'
import { VAULT_ADDRESS, CHAIN_ID, EXPLORER_BASE, buildTxUrl } from '../onchain-config'
import { VAULT_ABI } from '../vault-abi'
import { formatUsdc, formatAddress, formatTimestamp } from '../utils'
import type { AttemptResult } from './PayScreen'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface TxItem {
  txHash: string
  status: 'PAID' | 'REFUSED' | 'CANCELLED' | 'NOT_SENT'
  reason?: string          // DUPLICATE_INTENT | OVER_BUDGET | INTENT_EXPIRED | NOT_PAYER | REVERTED
  amount?: bigint
  to?: string
  timestamp?: number
  blockNumber?: bigint
  /** true when data came from the Blockscout API (survives refresh) */
  fromChain: boolean
}

// ─── Blockscout API types (minimal) ────────────────────────────────────────────

interface BlockscoutTx {
  hash: string
  status: 'ok' | 'error' | null
  timestamp: string
  block: number
  method: string | null
  decoded_input?: {
    method_id: string
    method_call: string
    parameters?: { name: string; value: string }[]
  } | null
  revert_reason?: string | null
}

interface BlockscoutResponse {
  items: BlockscoutTx[]
  next_page_params?: unknown
}

const glass = {
  card: {
    background: 'var(--surface)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    border: '1px solid var(--border)',
    borderRadius: '24px',
  } as React.CSSProperties,
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ActivityScreen({
  refreshTrigger,
  stormResults,
}: {
  refreshTrigger: number
  stormResults: AttemptResult[]
}) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID })

  const [chainItems, setChainItems] = useState<TxItem[]>([])
  const [loading, setLoading] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [lastFetched, setLastFetched] = useState<number | null>(null)

  // ── Decode revert reason by replaying the call ───────────────────────────────
  const decodeRevertReason = useCallback(async (
    hash: string,
    blockNumber: bigint,
    apiRevertReason: string | null | undefined,
  ): Promise<string> => {
    // First try: Blockscout may already give a decoded reason
    if (apiRevertReason) {
      for (const code of ['DUPLICATE_INTENT', 'INTENT_EXPIRED', 'OVER_BUDGET', 'NOT_PAYER']) {
        if (apiRevertReason.includes(code)) return code
      }
    }
    // Second try: replay via eth_call at the reverted block
    if (!publicClient) return 'REVERTED'
    try {
      const tx = await publicClient.getTransaction({ hash: hash as `0x${string}` })
      await publicClient.call({ to: tx.to ?? undefined, data: tx.input, blockNumber })
      return 'REVERTED'
    } catch (revertErr) {
      const msg = (revertErr as Error)?.message ?? ''
      for (const code of ['DUPLICATE_INTENT', 'INTENT_EXPIRED', 'OVER_BUDGET', 'NOT_PAYER']) {
        if (msg.includes(code)) return code
      }
      const data = (revertErr as { data?: `0x${string}` })?.data
      if (data && data !== '0x') {
        try {
          const decoded = decodeErrorResult({ abi: VAULT_ABI, data })
          return decoded.errorName
        } catch { /* fall through */ }
      }
    }
    return 'REVERTED'
  }, [publicClient])

  // ── Decode Paid event logs for a successful pay() tx ────────────────────────
  const decodePaidLog = useCallback(async (hash: string): Promise<{ amount?: bigint; to?: string }> => {
    if (!publicClient) return {}
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` })
      for (const log of receipt.logs as Log[]) {
        try {
          const decoded = decodeEventLog({ abi: VAULT_ABI, ...log })
          if (decoded.eventName === 'Paid') {
            const args = decoded.args as { intentId: `0x${string}`; to: `0x${string}`; amount: bigint }
            return { amount: args.amount, to: args.to }
          }
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
    return {}
  }, [publicClient])

  // ── Fetch from Blockscout ───────────────────────────────────────────────────
  const fetchFromApi = useCallback(async () => {
    setLoading(true)
    setApiError(null)
    try {
      // Fetch up to 50 most recent txs to the vault address
      const url = `${EXPLORER_BASE}/api/v2/addresses/${VAULT_ADDRESS}/transactions?filter=to&limit=50`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: BlockscoutResponse = await res.json()

      // Filter to pay() calls only (method id 0x2b0d8f18 or decoded method_call contains 'pay')
      const payTxs = json.items.filter(tx => {
        const m = tx.method ?? ''
        return m === 'pay' || m.startsWith('0x') // include un-decoded too, we re-check below
      })

      // Enrich each tx with decoded amount/to and revert reason
      const enriched = await Promise.all(
        payTxs.map(async (tx): Promise<TxItem> => {
          const blockNumber = BigInt(tx.block)
          const ts = tx.timestamp ? Math.floor(new Date(tx.timestamp).getTime() / 1000) : undefined

          if (tx.status === 'ok') {
            // Successful tx — decode the Paid event log for amount + recipient
            const { amount, to } = await decodePaidLog(tx.hash)
            return {
              txHash: tx.hash,
              status: 'PAID',
              amount,
              to,
              timestamp: ts,
              blockNumber,
              fromChain: true,
            }
          } else {
            // Failed/reverted tx — decode the reason
            const reason = await decodeRevertReason(tx.hash, blockNumber, tx.revert_reason)
            return {
              txHash: tx.hash,
              status: 'REFUSED',
              reason,
              timestamp: ts,
              blockNumber,
              fromChain: true,
            }
          }
        })
      )

      setChainItems(enriched)
      setLastFetched(Date.now())
    } catch (err) {
      console.error('Blockscout fetch failed:', err)
      setApiError('Could not load history from the explorer. The API may be temporarily unavailable.')
    } finally {
      setLoading(false)
    }
  }, [decodePaidLog, decodeRevertReason])

  useEffect(() => {
    fetchFromApi()
  }, [refreshTrigger, fetchFromApi])

  // ── Merge in-memory storm results (optimistic, deduped by hash) ───────────────
  const inMemoryItems: TxItem[] = stormResults
    .filter(r => r.txHash) // only results that actually broadcast
    .map(r => ({
      txHash: r.txHash!,
      status: r.status,
      reason: r.reason,
      blockNumber: r.blockNumber,
      fromChain: false,
    }))

  // Deduplicate: chain data wins over in-memory when same hash
  const chainHashes = new Set(chainItems.map(i => i.txHash.toLowerCase()))
  const uniqueInMemory = inMemoryItems.filter(i => !chainHashes.has(i.txHash.toLowerCase()))

  const allItems: TxItem[] = [...chainItems, ...uniqueInMemory].sort((a, b) => {
    const bN = b.blockNumber ?? 0n
    const aN = a.blockNumber ?? 0n
    if (bN !== aN) return bN > aN ? 1 : -1
    return (b.timestamp ?? 0) - (a.timestamp ?? 0)
  })

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {loading
            ? 'Loading…'
            : lastFetched
              ? `Updated ${new Date(lastFetched).toLocaleTimeString()}`
              : 'Fetching…'}
        </p>
        <button
          onClick={fetchFromApi}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition hover:opacity-80 disabled:opacity-40"
          style={{ background: 'var(--surface-muted)', color: 'var(--ink)' }}
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* API error state */}
      {apiError && (
        <div
          className="rounded-2xl p-4"
          style={{ background: 'rgba(186,43,76,0.05)', border: '1px solid rgba(186,43,76,0.18)' }}
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="size-5 mt-0.5 shrink-0" style={{ color: 'var(--danger)' }} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Could not load history</p>
              <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>{apiError}</p>
              <button
                onClick={fetchFromApi}
                className="mt-2 text-xs font-semibold underline"
                style={{ color: 'var(--danger)' }}
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Loading spinner */}
      {loading && allItems.length === 0 && (
        <div className="flex items-center justify-center py-12" style={{ color: 'var(--muted)' }}>
          <Loader2 className="size-5 animate-spin mr-2" />
          <span className="text-sm">Loading onchain history…</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && !apiError && allItems.length === 0 && (
        <div
          className="rounded-2xl p-8 text-center"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <CheckCircle2 className="size-8 mx-auto mb-3" style={{ color: 'var(--border-strong)' }} />
          <p className="text-sm font-medium" style={{ color: 'var(--ink-2)' }}>No activity yet</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Paid and refused pay() calls will appear here — including after a page refresh.
          </p>
        </div>
      )}

      {/* Items */}
      {allItems.map((item, i) => (
        <TxCard key={`${item.txHash}-${i}`} item={item} />
      ))}

      {/* Footer */}
      <div className="rounded-2xl p-4 text-xs" style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
        <p className="font-semibold mb-1" style={{ color: 'var(--ink-2)' }}>Data source</p>
        <p>
          Transactions fetched from the{' '}
          <a
            href={`${EXPLORER_BASE}/address/${VAULT_ADDRESS}`}
            target="_blank" rel="noopener noreferrer"
            className="mono font-medium underline"
            style={{ color: 'var(--accent-hover)' }}
          >
            Arc explorer API
          </a>
          {' '}— both successful and reverted pay() calls, including after a page refresh.
          Revert reasons decoded from the contract ABI.
        </p>
      </div>
    </div>
  )
}

// ─── Card ──────────────────────────────────────────────────────────────────────

function TxCard({ item }: { item: TxItem }) {
  const isPaid = item.status === 'PAID'
  const isNotSent = item.status === 'NOT_SENT' || item.status === 'CANCELLED'

  const bg = isPaid
    ? 'rgba(255,255,255,0.72)'
    : isNotSent
      ? 'rgba(245,245,248,0.8)'
      : 'rgba(254,242,242,0.7)'
  const border = isPaid
    ? 'rgba(26,128,71,0.18)'
    : isNotSent
      ? 'var(--border)'
      : 'rgba(186,43,76,0.18)'

  const Icon = isPaid ? CheckCircle2 : isNotSent ? MinusCircle : XCircle
  const iconBg = isPaid ? 'rgba(26,128,71,0.1)' : isNotSent ? 'rgba(107,101,128,0.08)' : 'rgba(186,43,76,0.1)'
  const iconColor = isPaid ? 'var(--success)' : isNotSent ? 'var(--muted)' : 'var(--danger)'

  const statusLabel = isPaid ? 'PAID' : item.reason ?? item.status
  const statusColor = isPaid ? 'var(--success)' : isNotSent ? 'var(--muted)' : 'var(--danger)'

  return (
    <div
      className="rounded-3xl p-4"
      style={{
        background: bg,
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        border: `1px solid ${border}`,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Left */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-xl" style={{ background: iconBg }}>
            <Icon className="size-4" style={{ color: iconColor }} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {item.amount !== undefined && (
                <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                  {formatUsdc(item.amount)} USDC
                </span>
              )}
              <span
                className="mono rounded-md px-1.5 py-0.5 text-xs font-semibold"
                style={{ background: isPaid ? 'rgba(26,128,71,0.08)' : 'rgba(186,43,76,0.08)', color: statusColor }}
              >
                {statusLabel}
              </span>
            </div>
            {item.to && (
              <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                To: <span className="mono">{formatAddress(item.to)}</span>
              </p>
            )}
            {item.blockNumber !== undefined && (
              <p className="mt-0.5 mono text-xs" style={{ color: 'var(--subtle)' }}>
                block {item.blockNumber.toString()}
              </p>
            )}
          </div>
        </div>

        {/* Right */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {item.timestamp !== undefined && (
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {formatTimestamp(item.timestamp)}
            </span>
          )}
          {/* Explorer link only when there is a real tx hash */}
          {item.txHash && item.txHash !== '0x' && (
            <a
              href={buildTxUrl(item.txHash)}
              target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs font-medium"
              style={{ color: isPaid ? 'var(--accent-hover)' : 'var(--danger)' }}
            >
              Explorer <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
