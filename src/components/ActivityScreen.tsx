/**
 * ActivityScreen — shows pay() calls (paid and refused) for a selected vault.
 *
 * Primary source: Blockscout API /api/v2/addresses/{vault}/transactions
 *   - No `limit` param (Blockscout v2 rejects it); follows next_page_params up to 3 pages.
 *   - Filters to pay() calls only: decoded_input.method_call starts with "pay(" OR
 *     tx input starts with pay() selector 0x1836304c.
 *   - Non-pay txs (fund, setBudget, withdrawUnspent) shown as neutral info rows.
 *   - Promise.allSettled per row: one failed decode only marks that row REVERTED.
 * Fallback: in-memory storm results (optimistic, deduped by hash).
 */

import { useEffect, useState, useCallback } from 'react'
import { usePublicClient } from 'wagmi'
import { decodeEventLog, type Log } from 'viem'
import {
  CheckCircle2, XCircle, ExternalLink, RefreshCw, Loader2,
  MinusCircle, AlertCircle, ArrowDownToLine, Target, Banknote,
} from 'lucide-react'
import { CHAIN_ID, EXPLORER_BASE, EXPLORER_API_BASE, buildTxUrl } from '../onchain-config'
import { VAULT_ABI } from '../vault-abi'
import { formatUsdc, formatAddress, formatTimestamp, decodeOnchainRevert } from '../utils'
import type { AttemptResult } from './PayScreen'

// pay() function selector (first 4 bytes of keccak256("pay(bytes32,address,uint256,uint64)"))
const PAY_SELECTOR = '0x1836304c'

type TxKind = 'PAID' | 'REFUSED' | 'CANCELLED' | 'NOT_SENT' | 'DEPOSIT' | 'BUDGET_SET' | 'WITHDRAW' | 'OTHER'

interface TxItem {
  txHash: string
  kind: TxKind
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
  // mainnet Blockscout uses block_number; testnet uses block — accept both
  block?: number | null
  block_number?: number | null
  method: string | null
  revert_reason?: string | null
  raw_input?: string
  decoded_input?: { method_call?: string } | null
}

interface BlockscoutResponse {
  items: BlockscoutTx[]
  next_page_params?: Record<string, string | number> | null
}

/** Safe block number extraction — handles mainnet (block_number) and testnet (block). */
function safeBlockNumber(tx: BlockscoutTx): bigint | undefined {
  const n = tx.block_number ?? tx.block
  if (n == null || Number.isNaN(n)) return undefined
  try { return BigInt(n) } catch { return undefined }
}

/** Returns true if a tx is a pay() call based on selector or decoded method name. */
function isPayCall(tx: BlockscoutTx): boolean {
  if (tx.decoded_input?.method_call?.startsWith('pay(')) return true
  const input = tx.raw_input ?? ''
  return input.toLowerCase().startsWith(PAY_SELECTOR)
}

/** Map method name to a neutral kind label. */
function neutralKind(tx: BlockscoutTx): TxKind {
  const m = (tx.decoded_input?.method_call ?? tx.method ?? '').toLowerCase()
  if (m.startsWith('fund')) return 'DEPOSIT'
  if (m.startsWith('setbudget') || m.startsWith('set_budget')) return 'BUDGET_SET'
  if (m.startsWith('withdrawunspent') || m.startsWith('withdraw')) return 'WITHDRAW'
  return 'OTHER'
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

  const replayRevert = useCallback(async (
    hash: string,
    apiReason?: string | null,
  ): Promise<string> => {
    if (!publicClient) return 'REVERTED'
    return decodeOnchainRevert(hash as `0x${string}`, VAULT_ABI, publicClient, vaultAddress, apiReason)
  }, [publicClient, vaultAddress])

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

  const fetchFromApi = useCallback(async () => {
    setLoading(true); setApiError(null)
    try {
      // Paginate: up to 3 pages, no `limit` param (Blockscout v2 rejects it)
      let allTxs: BlockscoutTx[] = []
      let nextParams: Record<string, string | number> | null = null
      for (let page = 0; page < 3; page++) {
        const qs = new URLSearchParams({ filter: 'to' })
        if (nextParams) {
          Object.entries(nextParams).forEach(([k, v]) => qs.set(k, String(v)))
        }
        const url = `${EXPLORER_API_BASE}/v2/addresses/${vaultAddress}/transactions?${qs}`
        const res = await fetch(url)
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          console.error(`Blockscout fetch failed: HTTP ${res.status}`, body)
          throw new Error(`HTTP ${res.status}`)
        }
        const json: BlockscoutResponse = await res.json()
        allTxs = allTxs.concat(json.items ?? [])
        nextParams = json.next_page_params ?? null
        if (!nextParams) break
      }

      // Enrich each tx with Promise.allSettled so one failed decode doesn't abort the list
      const settledResults = await Promise.allSettled(allTxs.map(async (tx): Promise<TxItem> => {
        const blockNumber = safeBlockNumber(tx)
        const ts = tx.timestamp ? Math.floor(new Date(tx.timestamp).getTime() / 1000) : undefined

        if (!isPayCall(tx)) {
          // Non-pay tx — show as neutral info row, never as PAID
          return {
            txHash: tx.hash,
            kind: neutralKind(tx),
            timestamp: ts,
            blockNumber,
            fromChain: true,
          }
        }

        if (tx.status === 'ok') {
          const { amount, to } = await decodePaidLog(tx.hash)
          return { txHash: tx.hash, kind: 'PAID', amount, to, timestamp: ts, blockNumber, fromChain: true }
        } else {
          const reason = await replayRevert(tx.hash, tx.revert_reason)
          return { txHash: tx.hash, kind: 'REFUSED', reason, timestamp: ts, blockNumber, fromChain: true }
        }
      }))

      const enriched: TxItem[] = settledResults.map((r, i) => {
        if (r.status === 'fulfilled') return r.value
        // Decode failed for this row — mark as REVERTED with the tx hash we do have
        return {
          txHash: allTxs[i]!.hash,
          kind: 'REFUSED' as TxKind,
          reason: 'REVERTED',
          blockNumber: safeBlockNumber(allTxs[i]!),
          fromChain: true,
        }
      })

      setChainItems(enriched)
      setLastFetched(Date.now())
    } catch (err) {
      console.error('Blockscout fetch failed:', err)
      setApiError('Could not load history from the explorer. The API may be temporarily unavailable.')
    } finally { setLoading(false) }
  }, [vaultAddress, decodePaidLog, replayRevert])

  useEffect(() => { fetchFromApi() }, [refreshTrigger, fetchFromApi])

  // Merge in-memory storm results (only paid/refused rows with a real hash)
  const inMemoryItems: TxItem[] = stormResults
    .filter(r => r.txHash && (r.status === 'PAID' || r.status === 'REFUSED'))
    .map(r => ({
      txHash: r.txHash!,
      kind: r.status as 'PAID' | 'REFUSED',
      reason: r.reason,
      blockNumber: r.blockNumber,
      fromChain: false,
    }))
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
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {loading ? 'Loading…' : lastFetched ? `Updated ${new Date(lastFetched).toLocaleTimeString()}` : 'Fetching…'}
        </p>
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
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>Paid and refused pay() calls will appear here after a refresh.</p>
        </div>
      )}

      {allItems.map((item, i) => <TxCard key={`${item.txHash}-${i}`} item={item} />)}

      <div className="rounded-2xl p-4 text-xs" style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
        <p className="font-semibold mb-1" style={{ color: 'var(--ink-2)' }}>Data source</p>
        <p>Fetched from the{' '}
          <a href={`${EXPLORER_BASE}/address/${vaultAddress}`} target="_blank" rel="noopener noreferrer"
            className="mono font-medium underline" style={{ color: 'var(--accent-hover)' }}>Arc explorer API</a>
          {' '}— pay() calls only. Deposit, budget, and withdraw transactions are shown as info rows.
        </p>
      </div>
    </div>
  )
}

function TxCard({ item }: { item: TxItem }) {
  const isPaid     = item.kind === 'PAID'
  const isRefused  = item.kind === 'REFUSED'
  const isNeutral  = !isPaid && !isRefused

  const bg     = isPaid ? 'rgba(255,255,255,0.72)' : isRefused ? 'rgba(254,242,242,0.7)' : 'rgba(245,245,248,0.8)'
  const border  = isPaid ? 'rgba(26,128,71,0.18)' : isRefused ? 'rgba(186,43,76,0.18)' : 'var(--border)'
  const iconBg  = isPaid ? 'rgba(26,128,71,0.1)' : isRefused ? 'rgba(186,43,76,0.1)' : 'rgba(107,101,128,0.08)'
  const iconColor = isPaid ? 'var(--success)' : isRefused ? 'var(--danger)' : 'var(--muted)'
  const statusColor = isPaid ? 'var(--success)' : isRefused ? 'var(--danger)' : 'var(--muted)'

  const Icon =
    isPaid ? CheckCircle2 :
    isRefused ? XCircle :
    item.kind === 'DEPOSIT' ? ArrowDownToLine :
    item.kind === 'BUDGET_SET' ? Target :
    item.kind === 'WITHDRAW' ? Banknote :
    MinusCircle

  const kindLabel: Record<TxKind, string> = {
    PAID: 'PAID', REFUSED: item.reason ?? 'REFUSED', CANCELLED: 'CANCELLED',
    NOT_SENT: 'NOT SENT', DEPOSIT: 'DEPOSIT', BUDGET_SET: 'BUDGET SET',
    WITHDRAW: 'WITHDRAW', OTHER: 'OTHER',
  }
  const statusLabel = kindLabel[item.kind]

  return (
    <div className="rounded-3xl p-4"
      style={{ background: bg, backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)', border: `1px solid ${border}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-xl" style={{ background: iconBg }}>
            <Icon className="size-4" style={{ color: iconColor }} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {item.amount !== undefined && (
                <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{formatUsdc(item.amount)} USDC</span>
              )}
              <span className="mono rounded-md px-1.5 py-0.5 text-xs font-semibold"
                style={{
                  background: isPaid ? 'rgba(26,128,71,0.08)' : isRefused ? 'rgba(186,43,76,0.08)' : 'rgba(107,101,128,0.08)',
                  color: statusColor,
                }}>{statusLabel}</span>
            </div>
            {item.to && (
              <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                To: <span className="mono">{formatAddress(item.to)}</span>
              </p>
            )}
            {item.blockNumber !== undefined && (
              <p className="mt-0.5 mono text-xs" style={{ color: 'var(--subtle)' }}>block {item.blockNumber.toString()}</p>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {item.timestamp !== undefined && (
            <span className="text-xs" style={{ color: 'var(--muted)' }}>{formatTimestamp(item.timestamp)}</span>
          )}
          {item.txHash && item.txHash !== '0x' && (
            <a href={buildTxUrl(item.txHash)} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs font-medium"
              style={{ color: isPaid ? 'var(--accent-hover)' : isRefused ? 'var(--danger)' : 'var(--muted)' }}>
              Explorer <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
