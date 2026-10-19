import { useState, useCallback, useRef } from 'react'
import { useAccount, useSwitchChain, usePublicClient, useWalletClient } from 'wagmi'
import { keccak256, encodeAbiParameters, parseAbiParameters, encodeFunctionData, decodeErrorResult } from 'viem'
import { Loader2, Zap, RefreshCw, CheckCircle2, XCircle, Copy, ExternalLink } from 'lucide-react'
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

/** Decode a revert reason from raw error data returned in a receipt */
function decodeRevertFromReceipt(err: unknown): string {
  try {
    // Try to extract from ContractFunctionRevertedError
    const msg = (err as Error)?.message ?? String(err)
    for (const code of ['DUPLICATE_INTENT', 'INTENT_EXPIRED', 'OVER_BUDGET', 'NOT_PAYER']) {
      if (msg.includes(code)) return code
    }
    // Try decoding raw error data if present
    const data = (err as { data?: `0x${string}` })?.data
    if (data && data !== '0x') {
      const decoded = decodeErrorResult({ abi: VAULT_ABI, data })
      return decoded.errorName
    }
  } catch { /* fall through */ }
  return parseRevertReason(err)
}

export interface AttemptResult {
  index: number
  status: 'PAID' | 'REFUSED'
  reason?: string
  txHash: `0x${string}`
}

function generateIntentId(recipient: string, amount: string, nonce: string): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('address, uint256, string'),
      [recipient as `0x${string}`, parseUsdc(amount), nonce]
    )
  )
}

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
  const [stormProgress, setStormProgress] = useState(0)

  const currentIntentId: `0x${string}` =
    lockedIntentId ??
    generateIntentId(
      recipient || '0x0000000000000000000000000000000000000000',
      amount || '0',
      nonce,
    )

  // ── Single pay ───────────────────────────────────────────────────────────────
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
      await publicClient.waitForTransactionReceipt({ hash })
      const result: AttemptResult = { index: 1, status: 'PAID', txHash: hash }
      setSingleResult(result)
      toast.success('Payment confirmed onchain')
      onActivity()
    } catch (err) {
      const reason = decodeRevertFromReceipt(err)
      // Even on revert we may have a tx hash — extract it
      const hash = (err as { transactionHash?: `0x${string}` })?.transactionHash
      if (hash) {
        const result: AttemptResult = { index: 1, status: 'REFUSED', reason, txHash: hash }
        setSingleResult(result)
      } else {
        toast.error(reason === 'CANCELLED' ? 'Cancelled' : `Refused: ${reason}`)
      }
    } finally {
      setIsSinglePaying(false)
    }
  }

  // ── Retry storm: 5 REAL onchain transactions ─────────────────────────────────
  const handleRetryStorm = useCallback(async () => {
    if (!isConnected || !walletClient || !publicClient) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID as 5042002 }); return }
    if (!recipient || !amount) { toast.error('Fill in recipient and amount'); return }

    const id = currentIntentId
    setLockedIntentId(id)
    setIsStorming(true)
    setStormResults([])
    setStormProgress(0)

    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const rawAmount = parseUsdc(amount)

    const results: AttemptResult[] = []

    for (let i = 0; i < 5; i++) {
      setStormProgress(i + 1)
      try {
        // Send a real transaction every time.
        // Attempts 2–5 will revert onchain with DUPLICATE_INTENT.
        // We pass an explicit gas limit so the wallet doesn't reject on simulation.
        const hash = await walletClient.writeContract({
          address: VAULT_ADDRESS,
          abi: VAULT_ABI,
          functionName: 'pay',
          args: [id, recipient as `0x${string}`, rawAmount, expiresAt],
          gas: 150_000n,
        })
        // Wait for the receipt to confirm success or revert
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status === 'success') {
          results.push({ index: i + 1, status: 'PAID', txHash: hash })
          toast.success(`Attempt ${i + 1}: PAID`)
          onActivity()
        } else {
          // Tx landed but reverted — decode reason from the receipt
          let reason = 'REVERTED'
          try {
            const tx = await publicClient.getTransaction({ hash })
            const callResult = await publicClient.call({
              to: tx.to ?? undefined,
              data: tx.input,
              blockNumber: receipt.blockNumber,
            }).catch(e => { throw e })
            void callResult // shouldn't reach here; revert surfaces in catch
          } catch (revertErr) {
            reason = decodeRevertFromReceipt(revertErr)
          }
          results.push({ index: i + 1, status: 'REFUSED', reason, txHash: hash })
          toast.error(`Attempt ${i + 1}: ${reason}`)
        }
      } catch (err) {
        // walletClient.writeContract throws before a tx hash when the wallet
        // rejects locally. If it threw AFTER submission, extract the hash.
        const hash = (err as { transactionHash?: `0x${string}` })?.transactionHash
        const reason = decodeRevertFromReceipt(err)
        if (hash) {
          results.push({ index: i + 1, status: 'REFUSED', reason, txHash: hash })
          toast.error(`Attempt ${i + 1}: ${reason}`)
        } else {
          // Wallet rejected before broadcast (user cancelled or local sim failed).
          // Stop the storm — user must re-approve or something systemic is wrong.
          toast.error(`Attempt ${i + 1} not sent: ${reason}`)
          // Pad remaining slots so results array is complete
          for (let j = i + 1; j < 5; j++) {
            results.push({ index: j + 1, status: 'REFUSED', reason: 'NOT_SENT', txHash: '0x' as `0x${string}` })
          }
          break
        }
      }
    }

    setStormResults(results)
    onStormResults(results)
    setIsStorming(false)
    setStormProgress(0)
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
              : isSinglePaying ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" />Confirming…</span>
                : 'Pay Once'}
        </button>

        {singleResult && (
          <AttemptRow result={singleResult} className="mt-3" />
        )}
      </section>

      {/* Retry storm */}
      <section style={glass.card} className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Zap className="size-4" style={{ color: '#e5a100' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Retry Storm</span>
        </div>
        <p className="mb-4 text-xs" style={{ color: 'var(--muted)' }}>
          Fires the same intent as <span className="mono font-semibold">5 real onchain transactions</span>.
          Exactly 1 succeeds; the rest land onchain and revert with <span className="mono">DUPLICATE_INTENT</span>.
        </p>
        <button
          onClick={handleRetryStorm}
          disabled={!recipient || !amount || isStorming || isSinglePaying || !isConnected}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: '#fff3cd', color: '#7c5100', border: '1px solid #e5a100' }}
        >
          {isStorming ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              Sending attempt {stormProgress} of 5…
            </span>
          ) : 'Retry Storm (×5 real txs)'}
        </button>

        {stormResults.length > 0 && (
          <div className="mt-4 space-y-2">
            {stormResults.map(r => (
              <AttemptRow key={r.index} result={r} />
            ))}
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

// ── Shared attempt row ─────────────────────────────────────────────────────────

function AttemptRow({ result, className = '' }: { result: AttemptResult; className?: string }) {
  return (
    <div
      className={`rounded-xl px-3 py-2.5 ${className}`}
      style={{
        background: result.status === 'PAID' ? 'rgba(26,128,71,0.06)' : 'rgba(186,43,76,0.05)',
        border: `1px solid ${result.status === 'PAID' ? 'rgba(26,128,71,0.18)' : 'rgba(186,43,76,0.12)'}`,
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {result.status === 'PAID'
            ? <CheckCircle2 className="size-4 shrink-0" style={{ color: 'var(--success)' }} />
            : <XCircle className="size-4 shrink-0" style={{ color: 'var(--danger)' }} />}
          <span className="text-xs font-medium" style={{ color: 'var(--ink)' }}>
            {result.index === 1 && !('reason' in result && result.reason) ? 'Attempt 1' : `Attempt ${result.index}`}
          </span>
        </div>
        <span
          className="mono text-xs font-semibold"
          style={{ color: result.status === 'PAID' ? 'var(--success)' : 'var(--danger)' }}
        >
          {result.status === 'PAID' ? 'PAID' : result.reason ?? 'REFUSED'}
        </span>
      </div>
      {result.txHash && result.txHash !== '0x' && (
        <div className="mt-1.5 flex items-center gap-1 pl-6">
          <a
            href={buildTxUrl(result.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="mono flex items-center gap-1 truncate text-xs"
            style={{ color: 'var(--accent-hover)' }}
          >
            {result.txHash.slice(0, 16)}… <ExternalLink className="size-3 shrink-0" />
          </a>
        </div>
      )}
    </div>
  )
}
