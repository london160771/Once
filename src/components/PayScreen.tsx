import { useState, useCallback, useEffect } from 'react'
import { useAccount, useSwitchChain, usePublicClient, useWalletClient, useReadContract } from 'wagmi'
import { keccak256, encodeAbiParameters, parseAbiParameters, erc20Abi } from 'viem'
import {
  Loader2, Zap, RefreshCw, CheckCircle2, XCircle, Copy, ExternalLink,
  MinusCircle, AlertTriangle, Info,
} from 'lucide-react'
import { CHAIN_ID, USDC_ADDRESS, buildTxUrl } from '../onchain-config'
import { VAULT_ABI } from '../vault-abi'
import { formatUsdc, parseUsdc, parseRevertReason, getFeeParams, decodeOnchainRevert } from '../utils'
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

export type AttemptStatus = 'PAID' | 'REFUSED' | 'CANCELLED' | 'NOT_SENT'

export interface AttemptResult {
  index: number
  status: AttemptStatus
  reason?: string
  txHash?: `0x${string}`
  blockNumber?: bigint
}

function generateIntentId(recipient: string, amount: string, nonce: string): `0x${string}` {
  return keccak256(encodeAbiParameters(
    parseAbiParameters('address, uint256, string'),
    [recipient as `0x${string}`, parseUsdc(amount), nonce],
  ))
}

export function PayScreen({
  vaultAddress,
  onActivity,
  onStormResults,
  onTxConfirmed,
}: {
  vaultAddress: `0x${string}`
  onActivity: () => void
  onStormResults: (results: AttemptResult[]) => void
  onTxConfirmed?: () => void
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
  const [alreadyPaidNote, setAlreadyPaidNote] = useState(false)

  const currentIntentId: `0x${string}` = lockedIntentId ?? generateIntentId(
    recipient || '0x0000000000000000000000000000000000000000', amount || '0', nonce,
  )

  // ── Live vault stats for amount warnings ──────────────────────────────────
  const { data: approvedBudget } = useReadContract({
    address: vaultAddress, abi: VAULT_ABI, functionName: 'approvedBudget', chainId: CHAIN_ID,
  })
  const { data: totalPaid } = useReadContract({
    address: vaultAddress, abi: VAULT_ABI, functionName: 'totalPaid', chainId: CHAIN_ID,
  })
  const { data: vaultBalance } = useReadContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf',
    args: [vaultAddress], chainId: CHAIN_ID,
  })

  const remaining = (approvedBudget !== undefined && totalPaid !== undefined)
    ? (approvedBudget as bigint) - (totalPaid as bigint)
    : undefined
  const rawAmount = parseUsdc(amount)

  // Warnings (warn only, don't block except for balance)
  const overBudget  = remaining !== undefined && rawAmount > 0n && rawAmount > remaining
  const underFunded = vaultBalance !== undefined && remaining !== undefined && rawAmount > 0n
    && rawAmount <= remaining && rawAmount > (vaultBalance as bigint)
  // Disable send only when vault can't cover it (not contract-refusable, just transfer fails)
  const sendDisabled = underFunded || !recipient || !amount || isSinglePaying || isStorming

  // ── Shared revert replay ──────────────────────────────────────────────────
  async function replayRevert(hash: `0x${string}`): Promise<string> {
    if (!publicClient) return 'REVERTED'
    return decodeOnchainRevert(hash, VAULT_ABI, publicClient, vaultAddress)
  }

  // ── Auto-regenerate intentId after a pay/storm completes ─────────────────
  const regenerate = useCallback((silent = false) => {
    setNonce(crypto.randomUUID())
    setLockedIntentId(null)
    setAlreadyPaidNote(false)
    if (!silent) { setStormResults([]); setSingleResult(null) }
  }, [])

  // ── paidIntents pre-check before a single pay ────────────────────────────
  async function checkAndMaybeRegenerate(intentId: `0x${string}`): Promise<`0x${string}`> {
    if (!publicClient) return intentId
    try {
      const isPaid = await publicClient.readContract({
        address: vaultAddress, abi: VAULT_ABI, functionName: 'paidIntents', args: [intentId],
      })
      if (isPaid) {
        const newNonce = crypto.randomUUID()
        const newId = generateIntentId(
          recipient || '0x0000000000000000000000000000000000000000', amount || '0', newNonce,
        )
        setNonce(newNonce)
        setLockedIntentId(null)
        setAlreadyPaidNote(true)
        return newId
      }
    } catch { /* proceed with original id */ }
    return intentId
  }

  // ── handlePay ─────────────────────────────────────────────────────────────
  const handlePay = async () => {
    if (!isConnected || !walletClient || !publicClient) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID }); return }
    if (!recipient || !amount) { toast.error('Fill in recipient and amount'); return }

    setSingleResult(null); setIsSinglePaying(true)
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600)

    // Pre-check paidIntents; auto-regen if already used
    const id = await checkAndMaybeRegenerate(currentIntentId)
    setLockedIntentId(id)

    let payFee
    try { payFee = await getFeeParams(publicClient) }
    catch (feeErr) {
      setSingleResult({ index: 1, status: 'NOT_SENT', reason: (feeErr as Error).message })
      toast.error((feeErr as Error).message); setIsSinglePaying(false); return
    }
    const { maxFeePerGas: mfpg, maxPriorityFeePerGas: mpfpg } = payFee

    try {
      const hash = await walletClient.writeContract({
        address: vaultAddress, abi: VAULT_ABI, functionName: 'pay',
        args: [id, recipient as `0x${string}`, parseUsdc(amount), expiresAt],
        gas: 150_000n, maxFeePerGas: mfpg, maxPriorityFeePerGas: mpfpg,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status === 'success') {
        setSingleResult({ index: 1, status: 'PAID', txHash: hash, blockNumber: receipt.blockNumber })
        toast.success('Payment confirmed'); onActivity(); onTxConfirmed?.()
      } else {
        const reason = await replayRevert(hash)
        setSingleResult({ index: 1, status: 'REFUSED', reason, txHash: hash, blockNumber: receipt.blockNumber })
        toast.error(`Refused: ${reason}`)
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? ''
      if (msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('user denied')) {
        setSingleResult({ index: 1, status: 'CANCELLED' }); toast.info('Cancelled')
      } else {
        const hash = (err as { transactionHash?: `0x${string}` })?.transactionHash
        const reason = parseRevertReason(err)
        setSingleResult({ index: 1, status: 'REFUSED', reason, txHash: hash })
        toast.error(`Refused: ${reason}`)
      }
    } finally {
      setIsSinglePaying(false)
      // Auto-regenerate for next payout
      regenerate(true)
    }
  }

  // ── handleRetryStorm ──────────────────────────────────────────────────────
  const handleRetryStorm = useCallback(async () => {
    if (!isConnected || !walletClient || !publicClient) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID }); return }
    if (!recipient || !amount) { toast.error('Fill in recipient and amount'); return }

    const id = currentIntentId
    setLockedIntentId(id); setIsStorming(true); setStormResults([])
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const rawAmt = parseUsdc(amount)

    type SendOutcome =
      | { sent: true; index: number; hash: `0x${string}` }
      | { sent: false; index: number; status: 'CANCELLED' | 'NOT_SENT'; reason?: string }

    let stormFee
    try { stormFee = await getFeeParams(publicClient) }
    catch (feeErr) {
      toast.error((feeErr as Error).message)
      setStormResults([{ index: 1, status: 'NOT_SENT', reason: (feeErr as Error).message },
        ...[2,3,4,5].map(i => ({ index: i, status: 'NOT_SENT' as const }))])
      setIsStorming(false); return
    }
    const { maxFeePerGas: stormMfpg, maxPriorityFeePerGas: stormMpfpg } = stormFee

    const sendOutcomes: SendOutcome[] = []
    let cancelledAt: number | null = null

    for (let i = 0; i < 5; i++) {
      if (cancelledAt !== null) { sendOutcomes.push({ sent: false, index: i + 1, status: 'NOT_SENT' }); continue }
      try {
        const hash = await walletClient.writeContract({
          address: vaultAddress, abi: VAULT_ABI, functionName: 'pay',
          args: [id, recipient as `0x${string}`, rawAmt, expiresAt],
          gas: 150_000n, maxFeePerGas: stormMfpg, maxPriorityFeePerGas: stormMpfpg,
        })
        sendOutcomes.push({ sent: true, index: i + 1, hash })
      } catch (err) {
        const msg = (err as Error)?.message ?? ''
        if (msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('user denied')) {
          cancelledAt = i + 1; sendOutcomes.push({ sent: false, index: i + 1, status: 'CANCELLED' })
        } else {
          const hash = (err as { transactionHash?: `0x${string}` })?.transactionHash
          if (hash) sendOutcomes.push({ sent: true, index: i + 1, hash })
          else sendOutcomes.push({ sent: false, index: i + 1, status: 'NOT_SENT', reason: parseRevertReason(err) })
        }
      }
    }

    const broadcastOutcomes = sendOutcomes.filter((o): o is Extract<SendOutcome, { sent: true }> => o.sent)
    const receiptResults = await Promise.all(broadcastOutcomes.map(async o => {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: o.hash })
        if (receipt.status === 'success')
          return { index: o.index, status: 'PAID' as const, txHash: o.hash, blockNumber: receipt.blockNumber }
        const reason = await replayRevert(o.hash)
        return { index: o.index, status: 'REFUSED' as const, reason, txHash: o.hash, blockNumber: receipt.blockNumber }
      } catch (err) {
        return { index: o.index, status: 'REFUSED' as const, reason: parseRevertReason(err), txHash: o.hash }
      }
    }))

    const receiptMap = new Map(receiptResults.map(r => [r.index, r]))
    const finalResults: AttemptResult[] = sendOutcomes.map(o => {
      if (!o.sent) return { index: o.index, status: o.status, reason: 'reason' in o ? o.reason : undefined }
      const r = receiptMap.get(o.index)
      return r ?? { index: o.index, status: 'REFUSED' as const, reason: 'REVERTED', txHash: o.hash }
    })

    if (finalResults.some(r => r.status === 'PAID')) { onActivity(); onTxConfirmed?.() }
    setStormResults(finalResults); onStormResults(finalResults); setIsStorming(false)
    // Auto-regenerate for next payout after storm
    regenerate(true)
  }, [isConnected, walletClient, publicClient, wrongChain, recipient, amount,
      currentIntentId, switchChain, onActivity, onStormResults, onTxConfirmed, vaultAddress, regenerate])

  const regenerateManual = () => regenerate(false)
  const copyId = () => { navigator.clipboard.writeText(currentIntentId); toast.info('Intent ID copied') }

  // Clear already-paid note when intentId changes
  useEffect(() => { setAlreadyPaidNote(false) }, [currentIntentId])

  void address

  return (
    <div className="space-y-4">
      <section style={glass.card} className="p-5">
        <h2 className="mb-4 text-sm font-semibold" style={{ color: 'var(--ink)' }}>Send USDC</h2>

        {/* Recipient */}
        <div className="mb-3">
          <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--muted)' }}>Recipient address</label>
          <div style={glass.inner} className="px-4 py-3">
            <input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="0x…"
              className="mono w-full bg-transparent text-sm outline-none placeholder:text-slate-300" style={{ color: 'var(--ink)' }} />
          </div>
        </div>

        {/* Amount */}
        <div className="mb-4">
          <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--muted)' }}>Amount (USDC)</label>
          <div style={glass.inner} className="p-4">
            <input inputMode="decimal" value={amount}
              onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ''); if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v) }}
              placeholder="0.00"
              className="display w-full bg-transparent text-3xl font-bold tabular-nums outline-none placeholder:text-slate-300"
              style={{ color: 'var(--ink)' }} />
            <div className="mt-1 flex items-center justify-between">
              <p className="text-xs" style={{ color: 'var(--subtle)' }}>USDC</p>
              {remaining !== undefined && (
                <p className="text-xs" style={{ color: 'var(--muted)' }}>
                  Remaining budget: <span className="mono font-medium">{formatUsdc(remaining)}</span>
                  {vaultBalance !== undefined && (
                    <> · Balance: <span className="mono font-medium">{formatUsdc(vaultBalance as bigint)}</span></>
                  )}
                </p>
              )}
            </div>
          </div>
          {/* Amount warnings */}
          {overBudget && (
            <div className="mt-2 flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs"
              style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)', color: '#92400e' }}>
              <AlertTriangle className="size-3.5 mt-0.5 shrink-0 text-amber-500" />
              <span>Exceeds remaining budget ({formatUsdc(remaining)} USDC) — the contract will refuse this with <span className="mono font-semibold">OVER_BUDGET</span>. You can still send to demonstrate the onchain refusal.</span>
            </div>
          )}
          {underFunded && (
            <div className="mt-2 flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs"
              style={{ background: 'rgba(186,43,76,0.05)', border: '1px solid rgba(186,43,76,0.18)', color: 'var(--danger)' }}>
              <AlertTriangle className="size-3.5 mt-0.5 shrink-0" style={{ color: 'var(--danger)' }} />
              <span>Vault balance is too low ({formatUsdc(vaultBalance as bigint)} USDC) — deposit first. Sending would fail inside the USDC transfer without a clear reason code.</span>
            </div>
          )}
        </div>

        {/* Intent ID */}
        <div className="mb-4 rounded-xl p-3" style={{ background: 'var(--surface-muted)' }}>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Intent ID</span>
            <div className="flex items-center gap-2">
              <button onClick={copyId} className="flex items-center gap-1 text-xs" style={{ color: 'var(--accent-hover)' }}>
                <Copy className="size-3" /> Copy
              </button>
              <button onClick={regenerateManual} className="flex items-center gap-1 text-xs" style={{ color: 'var(--accent-hover)' }}>
                <RefreshCw className="size-3" /> New
              </button>
            </div>
          </div>
          <p className="mono truncate text-xs" style={{ color: 'var(--ink-2)' }}>{currentIntentId}</p>
          {alreadyPaidNote && (
            <div className="mt-2 flex items-center gap-1.5 text-xs" style={{ color: '#b45309' }}>
              <Info className="size-3 shrink-0" />
              This intent was already paid — a new ID was generated.
            </div>
          )}
        </div>

        <button onClick={handlePay} disabled={sendDisabled}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: 'var(--accent)' }}>
          {!isConnected ? 'Connect Wallet'
            : wrongChain ? 'Switch to Arc'
            : isSinglePaying
              ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" />Confirming…</span>
              : underFunded ? 'Deposit USDC first'
              : 'Pay Once'}
        </button>
        {singleResult && <AttemptRow result={singleResult} className="mt-3" />}
      </section>

      <section style={glass.card} className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Zap className="size-4" style={{ color: '#e5a100' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Retry Storm</span>
        </div>
        <p className="mb-4 text-xs" style={{ color: 'var(--muted)' }}>
          Fires the same payout <span className="mono font-semibold">5 times back-to-back</span>.
          Exactly 1 is paid; the rest are refused onchain.
        </p>
        <button onClick={handleRetryStorm} disabled={!recipient || !amount || isStorming || isSinglePaying || !isConnected}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: '#fff3cd', color: '#7c5100', border: '1px solid #e5a100' }}>
          {isStorming
            ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" />Sending all 5 — waiting for receipts…</span>
            : 'Retry Storm (×5 real txs)'}
        </button>
        {stormResults.length > 0 && (
          <div className="mt-4 space-y-2">{stormResults.map(r => <AttemptRow key={r.index} result={r} />)}</div>
        )}
      </section>

      <div className="rounded-2xl p-4 text-xs" style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
        <p className="font-semibold mb-1" style={{ color: 'var(--ink-2)' }}>How idempotency works</p>
        <p>Each intent is identified by a <span className="mono">bytes32</span> hash. The contract marks it <span className="mono">paid</span> before transferring, so any retry is rejected with <span className="mono">DUPLICATE_INTENT</span>.</p>
      </div>
    </div>
  )
}

function AttemptRow({ result, className = '' }: { result: AttemptResult; className?: string }) {
  const isPaid = result.status === 'PAID'
  const isCancelled = result.status === 'CANCELLED' || result.status === 'NOT_SENT'
  const hasRealHash = !!result.txHash
  const bg = isPaid ? 'rgba(26,128,71,0.06)' : isCancelled ? 'rgba(107,101,128,0.06)' : 'rgba(186,43,76,0.05)'
  const border = isPaid ? 'rgba(26,128,71,0.18)' : isCancelled ? 'rgba(107,101,128,0.15)' : 'rgba(186,43,76,0.12)'
  const labelColor = isPaid ? 'var(--success)' : isCancelled ? 'var(--muted)' : 'var(--danger)'
  const label = isPaid ? 'PAID' : result.reason ?? result.status
  const Icon = isPaid ? CheckCircle2 : isCancelled ? MinusCircle : XCircle
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
      {hasRealHash && (
        <div className="mt-1.5 flex items-center gap-1 pl-6">
          <a href={buildTxUrl(result.txHash!)} target="_blank" rel="noopener noreferrer"
            className="mono flex items-center gap-1 truncate text-xs" style={{ color: 'var(--accent-hover)' }}>
            {result.txHash!.slice(0, 16)}… <ExternalLink className="size-3 shrink-0" />
          </a>
        </div>
      )}
    </div>
  )
}
