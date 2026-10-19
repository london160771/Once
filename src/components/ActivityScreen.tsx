import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { decodeEventLog, type Log } from 'viem'
import { CheckCircle2, XCircle, ExternalLink, RefreshCw } from 'lucide-react'
import { VAULT_ADDRESS, CHAIN_ID, buildTxUrl } from '../onchain-config'
import { VAULT_ABI } from '../vault-abi'
import { formatUsdc, formatAddress, formatTimestamp } from '../utils'
import { Loader2 } from 'lucide-react'

interface PaidEvent {
  type: 'paid'
  intentId: string
  to: string
  amount: bigint
  txHash: string
  blockNumber: bigint
  timestamp?: number
}

interface RefusedAttempt {
  type: 'refused'
  reason: string
  to?: string
  amount?: bigint
  timestamp: number
}

type ActivityItem = PaidEvent | RefusedAttempt

const glass = {
  card: {
    background: 'var(--surface)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    border: '1px solid var(--border)',
    borderRadius: '24px',
  } as React.CSSProperties,
}

export function ActivityScreen({ refreshTrigger }: { refreshTrigger: number }) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID })
  const [events, setEvents] = useState<PaidEvent[]>([])
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
        } catch {
          // skip non-Paid events
        }
      }

      // Fetch timestamps for last 10 events
      const sorted = paid.sort((a, b) => Number(b.blockNumber - a.blockNumber)).slice(0, 20)
      const withTs = await Promise.all(
        sorted.map(async e => {
          try {
            const block = await publicClient.getBlock({ blockNumber: e.blockNumber })
            return { ...e, timestamp: Number(block.timestamp) }
          } catch {
            return e
          }
        })
      )
      setEvents(withTs)
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            {lastFetched ? `Updated ${new Date(lastFetched).toLocaleTimeString()}` : 'Fetching…'}
          </p>
        </div>
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

      {loading && events.length === 0 && (
        <div className="flex items-center justify-center py-12" style={{ color: 'var(--muted)' }}>
          <Loader2 className="size-5 animate-spin mr-2" />
          <span className="text-sm">Loading onchain events…</span>
        </div>
      )}

      {!loading && events.length === 0 && (
        <div
          className="rounded-2xl p-8 text-center"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <CheckCircle2 className="size-8 mx-auto mb-3" style={{ color: 'var(--border-strong)' }} />
          <p className="text-sm font-medium" style={{ color: 'var(--ink-2)' }}>No payments yet</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Paid events from the last 5,000 blocks will appear here.
          </p>
        </div>
      )}

      {events.map((e, i) => (
        <EventCard key={`${e.txHash}-${i}`} event={e} />
      ))}

      <div
        className="rounded-2xl p-4 text-xs"
        style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}
      >
        <p className="font-semibold mb-1" style={{ color: 'var(--ink-2)' }}>Data source</p>
        <p>
          Reading live <span className="mono">Paid</span> events from the vault contract at{' '}
          <a
            href={`https://explorer.testnet.arc.io/address/${VAULT_ADDRESS}`}
            target="_blank" rel="noopener noreferrer"
            className="mono font-medium underline"
            style={{ color: 'var(--accent-hover)' }}
          >
            {formatAddress(VAULT_ADDRESS)}
          </a>{' '}
          on Arc Testnet. Scanning last 5,000 blocks.
        </p>
      </div>
    </div>
  )
}

function EventCard({ event }: { event: PaidEvent }) {
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
              target="_blank"
              rel="noopener noreferrer"
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
