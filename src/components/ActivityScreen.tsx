import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { decodeEventLog, type Log } from 'viem'
import { CheckCircle2, XCircle, ExternalLink, RefreshCw, Loader2 } from 'lucide-react'
import { VAULT_ADDRESS, CHAIN_ID, buildTxUrl } from '../onchain-config'
import { VAULT_ABI } from '../vault-abi'
import { formatUsdc, formatAddress, formatTimestamp } from '../utils'
import type { AttemptResult } from './PayScreen'

interface PaidEvent {
  type: 'paid'
  intentId: string
  to: string
  amount: bigint
  txHash: string
  blockNumber: bigint
  timestamp?: number
}

interface RefusedItem {
  type: 'refused'
  index: number
  reason: string
  txHash: string
  // timestamp derived from when the storm ran — no block to fetch
  receivedAt: number
}

type ActivityItem = PaidEvent | RefusedItem

const glass = {
  card: {
    background: 'var(--surface)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    border: '1px solid var(--border)',
    borderRadius: '24px',
  } as React.CSSProperties,
}

export function ActivityScreen({
  refreshTrigger,
  stormResults,
}: {
  refreshTrigger: number
  stormResults: AttemptResult[]
}) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID })
  const [paidEvents, setPaidEvents] = useState<PaidEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [lastFetched, setLastFetched] = useState<number | null>(null)

  const fetchEvents = async () => {
    if (!publicClient) return
    setLoading(true)
    try {
      const head = await publicClient.getBlockNumber()
      const fromBlock = head > 5000n ? head - 5000n : 0n

      const logs: Log[] = await publicClient.getLogs({
        address: VAULT_ADDRESS,
        fromBlock,
        toBlock: head,
      })

      const paid: PaidEvent[] = []
      for (const log of logs) {
        try {
          const decoded = decodeEventLog({ abi: VAULT_ABI, ...log })
          if (decoded.eventName === 'Paid') {
            const args = decoded.args as { intentId: `0x${string}`; to: `0x${string}`; amount: bigint }
            paid.push({
              type: 'paid',
              intentId: args.intentId,
              to: args.to,
              amount: args.amount,
              txHash: log.transactionHash ?? '',
              blockNumber: log.blockNumber ?? 0n,
            })
          }
        } catch { /* skip non-Paid events */ }
      }

      // Fetch timestamps for the most recent events
      const sorted = paid.sort((a, b) => Number(b.blockNumber - a.blockNumber)).slice(0, 20)
      const withTs = await Promise.all(
        sorted.map(async e => {
          try {
            const block = await publicClient.getBlock({ blockNumber: e.blockNumber })
            return { ...e, timestamp: Number(block.timestamp) }
          } catch { return e }
        })
      )
      setPaidEvents(withTs)
      setLastFetched(Date.now())
    } catch (err) {
      console.error('Failed to fetch events:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchEvents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger, publicClient])

  // Build the refused list from storm results (attempts that landed onchain and reverted)
  const refusedItems: RefusedItem[] = stormResults
    .filter(r => r.status === 'REFUSED' && r.txHash && r.txHash !== '0x')
    .map(r => ({
      type: 'refused' as const,
      index: r.index,
      reason: r.reason ?? 'REFUSED',
      txHash: r.txHash,
      receivedAt: Date.now(),
    }))

  // Merge: paid events from chain + refused attempts from storm, newest first
  const allItems: ActivityItem[] = [
    ...paidEvents,
    ...refusedItems,
  ].sort((a, b) => {
    const tsA = a.type === 'paid' ? (a.timestamp ?? 0) : a.receivedAt / 1000
    const tsB = b.type === 'paid' ? (b.timestamp ?? 0) : b.receivedAt / 1000
    return tsB - tsA
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {lastFetched ? `Updated ${new Date(lastFetched).toLocaleTimeString()}` : 'Fetching…'}
        </p>
        <button
          onClick={fetchEvents}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition hover:opacity-80 disabled:opacity-40"
          style={{ background: 'var(--surface-muted)', color: 'var(--ink)' }}
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {loading && allItems.length === 0 && (
        <div className="flex items-center justify-center py-12" style={{ color: 'var(--muted)' }}>
          <Loader2 className="size-5 animate-spin mr-2" />
          <span className="text-sm">Loading onchain events…</span>
        </div>
      )}

      {!loading && allItems.length === 0 && (
        <div
          className="rounded-2xl p-8 text-center"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <CheckCircle2 className="size-8 mx-auto mb-3" style={{ color: 'var(--border-strong)' }} />
          <p className="text-sm font-medium" style={{ color: 'var(--ink-2)' }}>No activity yet</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Paid events from the last 5,000 blocks will appear here.<br />
            Retry Storm reverts will appear after you run a storm.
          </p>
        </div>
      )}

      {allItems.map((item, i) =>
        item.type === 'paid'
          ? <PaidCard key={`paid-${item.txHash}-${i}`} event={item} />
          : <RefusedCard key={`refused-${item.txHash}-${i}`} item={item} />
      )}

      <div
        className="rounded-2xl p-4 text-xs"
        style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}
      >
        <p className="font-semibold mb-1" style={{ color: 'var(--ink-2)' }}>Data source</p>
        <p>
          Live <span className="mono">Paid</span> events from{' '}
          <a
            href={`https://explorer.testnet.arc.io/address/${VAULT_ADDRESS}`}
            target="_blank" rel="noopener noreferrer"
            className="mono font-medium underline"
            style={{ color: 'var(--accent-hover)' }}
          >
            {formatAddress(VAULT_ADDRESS)}
          </a>{' '}
          (last 5,000 blocks) · Reverted attempts shown after a Retry Storm.
        </p>
      </div>
    </div>
  )
}

// ── Cards ──────────────────────────────────────────────────────────────────────

function PaidCard({ event }: { event: PaidEvent }) {
  return (
    <div style={glass.card} className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="flex size-8 shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'rgba(26,128,71,0.1)' }}
          >
            <CheckCircle2 className="size-4" style={{ color: 'var(--success)' }} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                {formatUsdc(event.amount)} USDC
              </span>
              <span
                className="rounded-md px-1.5 py-0.5 text-xs font-semibold"
                style={{ background: 'rgba(26,128,71,0.08)', color: 'var(--success)' }}
              >
                PAID
              </span>
            </div>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
              To: <span className="mono">{formatAddress(event.to)}</span>
            </p>
            <p className="mt-0.5 mono truncate text-xs" style={{ color: 'var(--subtle)' }}>
              ID: {event.intentId.slice(0, 18)}…
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {event.timestamp && (
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {formatTimestamp(event.timestamp)}
            </span>
          )}
          {event.txHash && (
            <a
              href={buildTxUrl(event.txHash)}
              target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs font-medium"
              style={{ color: 'var(--accent-hover)' }}
            >
              Explorer <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

function RefusedCard({ item }: { item: RefusedItem }) {
  return (
    <div
      className="rounded-3xl p-4"
      style={{
        background: 'rgba(254,242,242,0.7)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        border: '1px solid rgba(186,43,76,0.15)',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="flex size-8 shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'rgba(186,43,76,0.1)' }}
          >
            <XCircle className="size-4" style={{ color: 'var(--danger)' }} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                Attempt {item.index}
              </span>
              <span
                className="mono rounded-md px-1.5 py-0.5 text-xs font-semibold"
                style={{ background: 'rgba(186,43,76,0.08)', color: 'var(--danger)' }}
              >
                {item.reason}
              </span>
            </div>
            <p className="mt-0.5 mono truncate text-xs" style={{ color: 'var(--subtle)' }}>
              {item.txHash.slice(0, 22)}…
            </p>
          </div>
        </div>
        <a
          href={buildTxUrl(item.txHash)}
          target="_blank" rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-1 text-xs font-medium"
          style={{ color: 'var(--danger)' }}
        >
          Explorer <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  )
}
