import { useState, useCallback } from 'react'
import { useAccount, useSwitchChain, usePublicClient, useWalletClient } from 'wagmi'
import { keccak256, encodeAbiParameters, parseAbiParameters, decodeErrorResult } from 'viem'
import { Loader2, Zap, RefreshCw, CheckCircle2, XCircle, Copy, ExternalLink, MinusCircle } from 'lucide-react'
import { VAULT_ADDRESS, CHAIN_ID, buildTxUrl } from '../onchain-config'
import { VAULT_ABI } from '../vault-abi'
import { formatUsdc, parseUsdc, parseRevertReason } from '../utils'
import { toast } from 'sonner'

const glass = {
  card: {
    background: 'var(--surface)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    border: '1px solid var(--border)',
    borderRadius: '24px',
  } as React.CSSProperties,
  inner: {
    background: 'rgba(255,255,255,0.5)',
    border: '1px solid var(--border)',
    borderRadius: '16px',
  } as React.CSSProperties,
}

/** Decode a custom error name from a caught viem error */
function decodeRevertReason(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err)
  for (const code of ['DUPLICATE_INTENT', 'INTENT_EXPIRED', 'OVER_BUDGET', 'NOT_PAYER']) {
    if (msg.includes(code)) return code
  }
  const data = (err as { data?: `0x${string}` })?.data
  if (data && data !== '0x') {
    try {
      const decoded = decodeErrorResult({ abi: VAULT_ABI, data })
      return decoded.errorName
    } catch { /* fall through */ }
  }
  return parseRevertReason(err)
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export type AttemptStatus = 'PAID' | 'REFUSED' | 'CANCELLED' | 'NOT_SENT'

export interface AttemptResult {
  index: number
  status: AttemptStatus
  reason?: string
  /** Real tx hash. Only present when the tx was actually broadcast. */
  txHash?: `0x${string}`
  blockNumber?: bigint
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function generateIntentId(recipient: string, amount: string, nonce: string): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('address, uint256, string'),
      [recipient as `0x${string}`, parseUsdc(amount), nonce],
    ),
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PayScreen({
  onActivity,
  onStormResults,
}: {
  onActivity: () => void
  onStormResults: (results: AttemptResult[]) => void
}) {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain } = useSwitchChain()
  const publicClient = usePublicClient({ chainId: CHAIN_ID })
  const { data: walletClient } = useWalletClient({ chainId: CHAIN_ID })
  const wrongChain = isConnected && chainId !== CHAIN_ID

  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [nonce, setNonce] = useState(() => crypto.randomUUID())
  const [lockedIntentId, setLockedIntentId] = useState<`0x${string}` | null>(null)

  const [isSinglePaying, setIsSinglePaying] = useState(false)
  const [singleResult, setSingleResult] = useState<AttemptResult | null>(null)

  const [stormResults, setStormResults] = useState<AttemptResult[]>([])
  const [isStorming, setIsStorming] = useState(false)

  const currentIntentId: `0x${string}` =
    lockedIntentId ??
    generateIntentId(
      recipient || '0x0000000000000000000000000000000000000000',
      amount || '0',
      nonce,
    )

  // ── Single pay ────────────────────────────────────────────────────────────────
  const handlePay = async () => {
    if (!isConnected || !walletClient || !publicClient) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID as 5042002 }); return }
    if (!recipient || !amount) { toast.error('Fill in recipient and amount'); return }

    const id = currentIntentId
    setLockedIntentId(id)
    setSingleResult(null)
    setIsSinglePaying(true)

    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const rawAmount = parseUsdc(amount)

    try {
      const hash = await walletClient.writeContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: 'pay',
        args: [id, recipient as `0x${string}`, rawAmount, expiresAt],
        gas: 150_000n,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status === 'success') {
        const result: AttemptResult = { index: 1, status: 'PAID', txHash: hash, blockNumber: receipt.blockNumber }
        setSingleResult(result)
        toast.success('Payment confirmed onchain')
        onActivity()
      } else {
        // Reverted onchain — decode reason
        const reason = await decodeOnchainRevert(hash, receipt.blockNumber)
        const result: AttemptResult = { index: 1, status: 'REFUSED', reason, txHash: hash, blockNumber: receipt.blockNumber }
        setSingleResult(result)
        toast.error(`Refused: ${reason}`)
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? ''
      if (msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('user denied')) {
        setSingleResult({ index: 1, status: 'CANCELLED' })
        toast.info('Cancelled')
      } else {
        const hash = (err as { transactionHash?: `0x${string}` })?.transactionHash
        const reason = decodeRevertReason(err)
        setSingleResult({ index: 1, status: 'REFUSED', reason, txHash: hash })
        toast.error(`Refused: ${reason}`)
      }
    } finally {
      setIsSinglePaying(false)
    }
  }

  // Replay call at the reverted block to decode the custom error
  async function decodeOnchainRevert(hash: `0x${string}`, blockNumber: bigint): Promise<string> {
    if (!publicClient) return 'REVERTED'
    try {
      const tx = await publicClient.getTransaction({ hash })
      await publicClient.call({ to: tx.to ?? undefined, data: tx.input, blockNumber })
      return 'REVERTED' // shouldn't reach here
    } catch (revertErr) {
      return decodeRevertReason(revertErr)
    }
  }

  // ── Retry storm: 5 REAL txs fired back-to-back ───────────────────────────────
  // We collect all 5 hashes first WITHOUT awaiting receipts,
  // then Promise.all the receipts so they resolve in parallel.
  const handleRetryStorm = useCallback(async () => {
    if (!isConnected || !walletClient || !publicClient) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID as 5042002 }); return }
    if (!recipient || !amount) { toast.error('Fill in recipient and amount'); return }

    const id = currentIntentId
    setLockedIntentId(id)
    setIsStorming(true)
    setStormResults([])

    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const rawAmount = parseUsdc(amount)

    // Phase 1: fire all 5 without waiting for receipts
    type SendOutcome =
      | { sent: true; index: number; hash: `0x${string}` }
      | { sent: false; index: number; status: 'CANCELLED' | 'NOT_SENT'; reason?: string }

    const sendOutcomes: SendOutcome[] = []
    let cancelledAt: number | null = null

    for (let i = 0; i < 5; i++) {
      if (cancelledAt !== null) {
        // A prior wallet rejection means the user stopped approving — mark remaining NOT_SENT
        sendOutcomes.push({ sent: false, index: i + 1, status: 'NOT_SENT' })
        continue
      }
      try {
        // writeContract with gas: 150_000n bypasses local simulation so the
        // wallet sends all 5 even though attempts 2-5 will revert onchain.
        const hash = await walletClient.writeContract({
          address: VAULT_ADDRESS,
          abi: VAULT_ABI,
          functionName: 'pay',
          args: [id, recipient as `0x${string}`, rawAmount, expiresAt],
          gas: 150_000n,
        })
        sendOutcomes.push({ sent: true, index: i + 1, hash })
      } catch (err) {
        const msg = (err as Error)?.message ?? ''
        if (msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('user denied')) {
          cancelledAt = i + 1
          sendOutcomes.push({ sent: false, index: i + 1, status: 'CANCELLED' })
        } else {
          // Some wallets throw after broadcast with a transactionHash
          const hash = (err as { transactionHash?: `0x${string}` })?.transactionHash
          if (hash) {
            sendOutcomes.push({ sent: true, index: i + 1, hash })
          } else {
            sendOutcomes.push({ sent: false, index: i + 1, status: 'NOT_SENT', reason: decodeRevertReason(err) })
          }
        }
      }
    }

    // Phase 2: wait for all broadcast txs in parallel
    const broadcastOutcomes = sendOutcomes.filter((o): o is Extract<SendOutcome, { sent: true }> => o.sent)

    const receiptResults = await Promise.all(
      broadcastOutcomes.map(async o => {
        try {
          const receipt = await publicClient.waitForTransactionReceipt({ hash: o.hash })
          if (receipt.status === 'success') {
            return { index: o.index, status: 'PAID' as const, txHash: o.hash, blockNumber: receipt.blockNumber }
          } else {
            const reason = await decodeOnchainRevert(o.hash, receipt.blockNumber)
            return { index: o.index, status: 'REFUSED' as const, reason, txHash: o.hash, blockNumber: receipt.blockNumber }
          }
        } catch (err) {
          return { index: o.index, status: 'REFUSED' as const, reason: decodeRevertReason(err), txHash: o.hash }
        }
      }),
    )

    // Phase 3: merge send outcomes with receipt results, preserving send order
    const receiptMap = new Map(receiptResults.map(r => [r.index, r]))
    const finalResults: AttemptResult[] = sendOutcomes.map(o => {
      if (!o.sent) {
        return { index: o.index, status: o.status, reason: 'reason' in o ? o.reason : undefined }
      }
      const r = receiptMap.get(o.index)
      return r ?? { index: o.index, status: 'REFUSED' as const, reason: 'REVERTED', txHash: o.hash }
    })

    // Notify parent and activity screen
    const paidCount = finalResults.filter(r => r.status === 'PAID').length
    if (paidCount > 0) onActivity()

    setStormResults(finalResults)
    onStormResults(finalResults)
    setIsStorming(false)
  }, [isConnected, walletClient, publicClient, wrongChain, recipient, amount, currentIntentId, switchChain, onActivity, onStormResults])

  const regenerate = () => {
    setNonce(crypto.randomUUID())
    setLockedIntentId(null)
    setStormResults([])
    setSingleResult(null)
  }

  const copyId = () => {
    navigator.clipboard.writeText(currentIntentId)
    toast.info('Intent ID copied')
  }

  return (
    <div className="space-y-4">
      {/* Pay form */}
      <section style={glass.card} className="p-5">
        <h2 className="mb-4 text-sm font-semibold" style={{ color: 'var(--ink)' }}>Send USDC</h2>

        {/* Recipient */}
        <div className="mb-3">
          <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--muted)' }}>Recipient address</label>
          <div style={glass.inner} className="px-4 py-3">
            <input
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              placeholder="0x…"
              className="mono w-full bg-transparent text-sm outline-none placeholder:text-slate-300"
              style={{ color: 'var(--ink)' }}
            />
          </div>
        </div>

        {/* Amount */}
        <div className="mb-4">
          <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--muted)' }}>Amount (USDC)</label>
          <div style={glass.inner} className="p-4">
            <input
              inputMode="decimal"
              value={amount}
              onChange={e => {
                const v = e.target.value.replace(/[^0-9.]/g, '')
                if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v)
              }}
              placeholder="0.00"
              className="display w-full bg-transparent text-3xl font-bold tabular-nums outline-none placeholder:text-slate-300"
              style={{ color: 'var(--ink)' }}
            />
            <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>USDC</p>
          </div>
        </div>

        {/* Intent ID */}
        <div className="mb-4 rounded-xl p-3" style={{ background: 'var(--surface-muted)' }}>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Intent ID</span>
            <div className="flex items-center gap-2">
              <button onClick={copyId} className="flex items-center gap-1 text-xs" style={{ color: 'var(--accent-hover)' }}>
                <Copy className="size-3" /> Copy
              </button>
              <button onClick={regenerate} className="flex items-center gap-1 text-xs" style={{ color: 'var(--accent-hover)' }}>
                <RefreshCw className="size-3" /> New
              </button>
            </div>
          </div>
          <p className="mono truncate text-xs" style={{ color: 'var(--ink-2)' }}>{currentIntentId}</p>
        </div>

        {/* Pay button */}
        <button
          onClick={handlePay}
          disabled={!recipient || !amount || isSinglePaying || isStorming}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: 'var(--accent)' }}
        >
          {!isConnected ? 'Connect Wallet'
            : wrongChain ? 'Switch to Arc Testnet'
              : isSinglePaying
                ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" />Confirming…</span>
                : 'Pay Once'}
        </button>

        {singleResult && <AttemptRow result={singleResult} className="mt-3" />}
      </section>

      {/* Retry storm */}
      <section style={glass.card} className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Zap className="size-4" style={{ color: '#e5a100' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Retry Storm</span>
        </div>
        <p className="mb-4 text-xs" style={{ color: 'var(--muted)' }}>
          Fires the same payout <span className="mono font-semibold">5 times back-to-back</span>.
          Exactly 1 is paid; the rest are refused onchain.
        </p>
        <button
          onClick={handleRetryStorm}
          disabled={!recipient || !amount || isStorming || isSinglePaying || !isConnected}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: '#fff3cd', color: '#7c5100', border: '1px solid #e5a100' }}
        >
          {isStorming
            ? <span className="flex items-center justify-center gap-2">
                <Loader2 className="size-4 animate-spin" />Sending all 5 — waiting for receipts…
              </span>
            : 'Retry Storm (×5 real txs)'}
        </button>

        {stormResults.length > 0 && (
          <div className="mt-4 space-y-2">
            {stormResults.map(r => <AttemptRow key={r.index} result={r} />)}
          </div>
        )}
      </section>

      {/* Info */}
      <div className="rounded-2xl p-4 text-xs" style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
        <p className="font-semibold mb-1" style={{ color: 'var(--ink-2)' }}>How idempotency works</p>
        <p>Each intent is identified by a <span className="mono">bytes32</span> hash. The contract marks it <span className="mono">paid</span> before transferring, so any retry — from the same caller or another — is rejected with <span className="mono">DUPLICATE_INTENT</span>.</p>
      </div>
    </div>
  )
}

// ── Shared attempt row ──────────────────────────────────────────────────────────

function AttemptRow({ result, className = '' }: { result: AttemptResult; className?: string }) {
  const isPaid = result.status === 'PAID'
  const isCancelled = result.status === 'CANCELLED'
  const isNotSent = result.status === 'NOT_SENT'
  const hasRealHash = !!result.txHash  // txHash only set when broadcast

  const bg = isPaid
    ? 'rgba(26,128,71,0.06)'
    : isCancelled || isNotSent
      ? 'rgba(107,101,128,0.06)'
      : 'rgba(186,43,76,0.05)'
  const border = isPaid
    ? 'rgba(26,128,71,0.18)'
    : isCancelled || isNotSent
      ? 'rgba(107,101,128,0.15)'
      : 'rgba(186,43,76,0.12)'

  const labelColor = isPaid ? 'var(--success)' : isCancelled || isNotSent ? 'var(--muted)' : 'var(--danger)'
  const label = isPaid ? 'PAID' : result.reason ?? result.status

  const Icon = isPaid ? CheckCircle2 : isCancelled || isNotSent ? MinusCircle : XCircle

  const blockLabel = result.blockNumber !== undefined ? `block ${result.blockNumber}` : null

  return (
    <div className={`rounded-xl px-3 py-2.5 ${className}`} style={{ background: bg, border: `1px solid ${border}` }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="size-4 shrink-0" style={{ color: labelColor }} />
          <span className="text-xs font-medium" style={{ color: 'var(--ink)' }}>
            Attempt {result.index}
            {blockLabel && <span className="ml-1.5 mono" style={{ color: 'var(--subtle)', fontWeight: 400 }}>· {blockLabel}</span>}
          </span>
        </div>
        <span className="mono text-xs font-semibold" style={{ color: labelColor }}>{label}</span>
      </div>
      {/* Explorer link only when a real tx hash exists */}
      {hasRealHash && (
        <div className="mt-1.5 flex items-center gap-1 pl-6">
          <a
            href={buildTxUrl(result.txHash!)}
            target="_blank"
            rel="noopener noreferrer"
            className="mono flex items-center gap-1 truncate text-xs"
            style={{ color: 'var(--accent-hover)' }}
          >
            {result.txHash!.slice(0, 16)}… <ExternalLink className="size-3 shrink-0" />
          </a>
        </div>
      )}
    </div>
  )
}
