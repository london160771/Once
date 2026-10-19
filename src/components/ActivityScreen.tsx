/**
 * ActivityScreen — shows both successful pay() calls and failed/reverted ones
 * for a specific vault address.
 *
 * Primary source: Blockscout API /api/v2/addresses/{vault}/transactions
 * Fallback: in-memory storm results (optimistic, deduped by hash).
 */

import { useEffect, useState, useCallback } from 'react'
import { usePublicClient } from 'wagmi'
import { decodeErrorResult, decodeEventLog, type Log } from 'viem'
import { CheckCircle2, XCircle, ExternalLink, RefreshCw, Loader2, MinusCircle, AlertCircle } from 'lucide-react'
import { CHAIN_ID, EXPLORER_BASE, buildTxUrl } from '../onchain-config'
import { VAULT_ABI } from '../vault-abi'
import { formatUsdc, formatAddress, formatTimestamp } from '../utils'
import type { AttemptResult } from './PayScreen'
import { decodeFunctionData } from 'viem'

interface TxItem {
  txHash: string
  status: 'PAID' | 'REFUSED' | 'CANCELLED' | 'NOT_SENT'
  reason?: string
  amount?: bigint
  to?: string
  timestamp?: number
  blockNumber?: bigint
  fromChain: boolean
}

interface BlockscoutTx {
  hash: string
  status: 'ok' | 'error' | null
  timestamp: string
  block: number
  method: string | null
  revert_reason?: string | null
}

interface BlockscoutResponse {
  items: BlockscoutTx[]
  next_page_params?: unknown
}

export function ActivityScreen({
  vaultAddress,
  refreshTrigger,
  stormResults,
}: {
  vaultAddress: `0x${string}`
  refreshTrigger: number
  stormResults: AttemptResult[]
}) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID })
  const [chainItems, setChainItems] = useState<TxItem[]>([])
  const [loading, setLoading] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [lastFetched, setLastFetched] = useState<number | null>(null)

  /**
   * Decode order per spec:
   * (a) Explorer's revert_reason string — scan for known error names.
   * (b) eth_call at 'latest' with same calldata from same sender — gets ABI-decodable error bytes.
   * (c) For pay() calls: read paidIntents(intentId) — if true and not the PAID tx, it's DUPLICATE_INTENT.
   * (d) REVERTED — never show a generic FAILED.
   */
  const decodeRevertReason = useCallback(async (
    hash: string,
    _blockNumber: bigint,
    apiReason: string | null | undefined,
  ): Promise<string> => {
    const KNOWN = ['DUPLICATE_INTENT', 'INTENT_EXPIRED', 'OVER_BUDGET', 'NOT_PAYER']

    // (a) Explorer reason string
    if (apiReason) {
      for (const c of KNOWN) { if (apiReason.includes(c)) return c }
      // Also try hex-decoded ABI error from the revert_reason field
      if (apiReason.startsWith('0x')) {
        try { return decodeErrorResult({ abi: VAULT_ABI, data: apiReason as `0x${string}` }).errorName } catch { /* fall */ }
      }
    }

    if (!publicClient) return 'REVERTED'

    // (b) eth_call at 'latest' — Arc testnet has no historical state pruning at this RPC level
    //     so replaying at the original blockNumber often fails; 'latest' gives us the revert data
    try {
      const tx = await publicClient.getTransaction({ hash: hash as `0x${string}` })
      await publicClient.call({ to: tx.to ?? undefined, data: tx.input, account: tx.from })
      // No revert — possibly state has changed; fall through to (c)
    } catch (revertErr) {
      const msg = (revertErr as Error)?.message ?? ''
      for (const c of KNOWN) { if (msg.includes(c)) return c }
      const data = (revertErr as { data?: `0x${string}` })?.data
      if (data && data !== '0x') {
        try { return decodeErrorResult({ abi: VAULT_ABI, data }).errorName } catch { /* fall */ }
      }
    }

    // (c) paidIntents fallback — for pay() calls: if this tx isn't the PAID one and intent is marked
    //     paid, it must be DUPLICATE_INTENT. We can't extract intentId here without full input decoding,
    //     so we skip this and leave it to the caller to pass context if needed.

    return 'REVERTED'
  }, [publicClient])

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

  // Extract intentId from a pay() calldata input (used for paidIntents fallback)
  function extractIntentId(input: `0x${string}`): `0x${string}` | null {
    try {
      const decoded = decodeFunctionData({ abi: VAULT_ABI, data: input })
      if (decoded.functionName === 'pay') {
        const args = decoded.args as [`0x${string}`, `0x${string}`, bigint, bigint]
        return args[0]
      }
    } catch { /* not a pay() call */ }
    return null
  }

  const fetchFromApi = useCallback(async () => {
    setLoading(true); setApiError(null)
    try {
      const url = `${EXPLORER_BASE}/api/v2/addresses/${vaultAddress}/transactions?filter=to&limit=50`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: BlockscoutResponse = await res.json()

      const enriched = await Promise.all(json.items.map(async (tx): Promise<TxItem> => {
        const blockNumber = BigInt(tx.block)
        const ts = tx.timestamp ? Math.floor(new Date(tx.timestamp).getTime() / 1000) : undefined
        if (tx.status === 'ok') {
          const { amount, to } = await decodePaidLog(tx.hash)
          return { txHash: tx.hash, status: 'PAID', amount, to, timestamp: ts, blockNumber, fromChain: true }
        } else {
          let reason = await decodeRevertReason(tx.hash, blockNumber, tx.revert_reason)

          // (c) paidIntents fallback: if still REVERTED and it's a pay() call,
          //     check paidIntents(intentId) on-chain. If true → DUPLICATE_INTENT.
          if (reason === 'REVERTED' && publicClient) {
            try {
              const fullTx = await publicClient.getTransaction({ hash: tx.hash as `0x${string}` })
              const intentId = extractIntentId(fullTx.input)
              if (intentId) {
                const isPaid = await publicClient.readContract({
                  address: vaultAddress,
                  abi: VAULT_ABI,
                  functionName: 'paidIntents',
                  args: [intentId],
                })
                if (isPaid) reason = 'DUPLICATE_INTENT'
              }
            } catch { /* leave as REVERTED */ }
          }

          return { txHash: tx.hash, status: 'REFUSED', reason, timestamp: ts, blockNumber, fromChain: true }
        }
      }))

      setChainItems(enriched); setLastFetched(Date.now())
    } catch (err) {
      console.error('Blockscout fetch failed:', err)
      setApiError('Could not load history from the explorer. The API may be temporarily unavailable.')
    } finally { setLoading(false) }
  }, [vaultAddress, decodePaidLog, decodeRevertReason, publicClient])

  useEffect(() => { fetchFromApi() }, [refreshTrigger, fetchFromApi])

  const inMemoryItems: TxItem[] = stormResults.filter(r => r.txHash).map(r => ({ txHash: r.txHash!, status: r.status, reason: r.reason, blockNumber: r.blockNumber, fromChain: false }))
  const chainHashes = new Set(chainItems.map(i => i.txHash.toLowerCase()))
  const uniqueInMemory = inMemoryItems.filter(i => !chainHashes.has(i.txHash.toLowerCase()))
  const allItems = [...chainItems, ...uniqueInMemory].sort((a, b) => {
    const bN = b.blockNumber ?? 0n, aN = a.blockNumber ?? 0n
    if (bN !== aN) return bN > aN ? 1 : -1
    return (b.timestamp ?? 0) - (a.timestamp ?? 0)
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>{loading ? 'Loading…' : lastFetched ? `Updated ${new Date(lastFetched).toLocaleTimeString()}` : 'Fetching…'}</p>
        <button onClick={fetchFromApi} disabled={loading}
          className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition hover:opacity-80 disabled:opacity-40"
          style={{ background: 'var(--surface-muted)', color: 'var(--ink)' }}>
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {apiError && (
        <div className="rounded-2xl p-4" style={{ background: 'rgba(186,43,76,0.05)', border: '1px solid rgba(186,43,76,0.18)' }}>
          <div className="flex items-start gap-3">
            <AlertCircle className="size-5 mt-0.5 shrink-0" style={{ color: 'var(--danger)' }} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Could not load history</p>
              <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>{apiError}</p>
              <button onClick={fetchFromApi} className="mt-2 text-xs font-semibold underline" style={{ color: 'var(--danger)' }}>Retry</button>
            </div>
          </div>
        </div>
      )}

      {loading && allItems.length === 0 && (
        <div className="flex items-center justify-center py-12" style={{ color: 'var(--muted)' }}>
          <Loader2 className="size-5 animate-spin mr-2" /><span className="text-sm">Loading onchain history…</span>
        </div>
      )}

      {!loading && !apiError && allItems.length === 0 && (
        <div className="rounded-2xl p-8 text-center" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <CheckCircle2 className="size-8 mx-auto mb-3" style={{ color: 'var(--border-strong)' }} />
          <p className="text-sm font-medium" style={{ color: 'var(--ink-2)' }}>No activity yet</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>Paid and refused pay() calls will appear here after a page refresh.</p>
        </div>
      )}

      {allItems.map((item, i) => <TxCard key={`${item.txHash}-${i}`} item={item} />)}

      <div className="rounded-2xl p-4 text-xs" style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
        <p className="font-semibold mb-1" style={{ color: 'var(--ink-2)' }}>Data source</p>
        <p>Fetched from the <a href={`${EXPLORER_BASE}/address/${vaultAddress}`} target="_blank" rel="noopener noreferrer" className="mono font-medium underline" style={{ color: 'var(--accent-hover)' }}>Arc explorer API</a> — both successful and reverted pay() calls.</p>
      </div>
    </div>
  )
}

function TxCard({ item }: { item: TxItem }) {
  const isPaid = item.status === 'PAID', isNotSent = item.status === 'NOT_SENT' || item.status === 'CANCELLED'
  const bg = isPaid ? 'rgba(255,255,255,0.72)' : isNotSent ? 'rgba(245,245,248,0.8)' : 'rgba(254,242,242,0.7)'
  const border = isPaid ? 'rgba(26,128,71,0.18)' : isNotSent ? 'var(--border)' : 'rgba(186,43,76,0.18)'
  const Icon = isPaid ? CheckCircle2 : isNotSent ? MinusCircle : XCircle
  const iconBg = isPaid ? 'rgba(26,128,71,0.1)' : isNotSent ? 'rgba(107,101,128,0.08)' : 'rgba(186,43,76,0.1)'
  const iconColor = isPaid ? 'var(--success)' : isNotSent ? 'var(--muted)' : 'var(--danger)'
  const statusLabel = isPaid ? 'PAID' : item.reason ?? item.status
  const statusColor = isPaid ? 'var(--success)' : isNotSent ? 'var(--muted)' : 'var(--danger)'
  return (
    <div className="rounded-3xl p-4" style={{ background: bg, backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)', border: `1px solid ${border}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-xl" style={{ background: iconBg }}>
            <Icon className="size-4" style={{ color: iconColor }} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {item.amount !== undefined && <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{formatUsdc(item.amount)} USDC</span>}
              <span className="mono rounded-md px-1.5 py-0.5 text-xs font-semibold"
                style={{ background: isPaid ? 'rgba(26,128,71,0.08)' : 'rgba(186,43,76,0.08)', color: statusColor }}>{statusLabel}</span>
            </div>
            {item.to && <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>To: <span className="mono">{formatAddress(item.to)}</span></p>}
            {item.blockNumber !== undefined && <p className="mt-0.5 mono text-xs" style={{ color: 'var(--subtle)' }}>block {item.blockNumber.toString()}</p>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {item.timestamp !== undefined && <span className="text-xs" style={{ color: 'var(--muted)' }}>{formatTimestamp(item.timestamp)}</span>}
          {item.txHash && item.txHash !== '0x' && (
            <a href={buildTxUrl(item.txHash)} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs font-medium" style={{ color: isPaid ? 'var(--accent-hover)' : 'var(--danger)' }}>
              Explorer <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
