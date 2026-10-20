/**
 * VaultScreen — deposit, set budget, withdraw, and close out for a selected vault.
 * Receives the selected vault address as a prop (no hardcoded address).
 */

import React, { useState, useEffect, useRef } from 'react'
import {
  useAccount, useReadContracts, useWriteContract,
  useWaitForTransactionReceipt, useSwitchChain,
  useWalletClient, usePublicClient,
} from 'wagmi'
import { erc20Abi, decodeErrorResult } from 'viem'
import {
  Loader2, ShieldCheck, PiggyBank, Target, TrendingUp,
  ArrowDownToLine, PackageCheck, ExternalLink, BadgeCheck, BadgeX, AlertCircle,
} from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'
import { USDC_ADDRESS, CHAIN_ID, NETWORK, buildTxUrl } from '../onchain-config'
import { VAULT_ABI } from '../vault-abi'
import { formatUsdc, parseUsdc, formatAddress, getFeeParams, waitForReceiptWithRetry } from '../utils'
import { useIsOkxWallet } from '../hooks/useIsOkxWallet'
import { toast } from 'sonner'

// ─── Error decoding ────────────────────────────────────────────────────────────

const FRIENDLY: Record<string, string> = {
  OwnableUnauthorizedAccount: 'Only the vault owner can do this',
  NOT_PAYER:         'Caller is not an allowed payer',
  OVER_BUDGET:       'Amount exceeds the approved budget',
  DUPLICATE_INTENT:  'This intent was already paid',
  INTENT_EXPIRED:    'The intent has expired',
}

function decodeWriteError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err)
  if (msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('user denied')) return 'CANCELLED'
  for (const code of Object.keys(FRIENDLY)) {
    if (msg.includes(code)) return FRIENDLY[code] ?? code
  }
  const data = (err as { data?: `0x${string}` })?.data
  if (data && data !== '0x') {
    try {
      const decoded = decodeErrorResult({ abi: VAULT_ABI, data })
      return FRIENDLY[decoded.errorName] ?? decoded.errorName
    } catch { /* fall through */ }
  }
  return msg.length > 100 ? msg.slice(0, 100) + '…' : msg
}

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

export function VaultScreen({
  vaultAddress,
  refetchRef,
}: {
  vaultAddress: `0x${string}`
  refetchRef?: React.MutableRefObject<(() => void) | null>
}) {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain } = useSwitchChain()
  const { data: walletClient } = useWalletClient({ chainId: CHAIN_ID })
  const publicClient = usePublicClient({ chainId: CHAIN_ID })
  const wrongChain = isConnected && chainId !== CHAIN_ID
  const isOkx = useIsOkxWallet()

  const [depositAmount, setDepositAmount] = useState('')
  const [budgetAmount, setBudgetAmount] = useState('')

  // ── Contract reads — single multicall for all vault stats ─────────────────
  // Four reads coalesce into one eth_call via wagmi multicall batching.

  const { data: vaultReads, refetch: refetchVaultReads } = useReadContracts({
    contracts: [
      { address: vaultAddress,  abi: VAULT_ABI,  functionName: 'owner',          chainId: CHAIN_ID },
      { address: USDC_ADDRESS,  abi: erc20Abi,   functionName: 'balanceOf', args: [vaultAddress], chainId: CHAIN_ID },
      { address: vaultAddress,  abi: VAULT_ABI,  functionName: 'approvedBudget', chainId: CHAIN_ID },
      { address: vaultAddress,  abi: VAULT_ABI,  functionName: 'totalPaid',      chainId: CHAIN_ID },
    ],
    allowFailure: true,
  })

  // Separate wallet balance read (depends on connected address — can't batch with vault reads)
  const { data: walletBalanceReads } = useReadContracts({
    contracts: [
      {
        address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf',
        args: [address ?? '0x0000000000000000000000000000000000000000'],
        chainId: CHAIN_ID,
      },
    ],
    allowFailure: true,
    query: { enabled: !!address },
  })

  const vaultOwner     = vaultReads?.[0]?.result as `0x${string}` | undefined
  const vaultBalance   = vaultReads?.[1]?.result as bigint | undefined
  const approvedBudget = vaultReads?.[2]?.result as bigint | undefined
  const totalPaid      = vaultReads?.[3]?.result as bigint | undefined
  const walletBalance  = walletBalanceReads?.[0]?.result as bigint | undefined

  const isOwner = !!(address && vaultOwner && address.toLowerCase() === vaultOwner.toLowerCase())
  const remaining = (approvedBudget ?? 0n) - (totalPaid ?? 0n)
  // refetchAll only refreshes local vault reads — never calls back into App to avoid loops.
  const refetchAll = () => { void refetchVaultReads() }

  // Expose refetchAll to parent via ref so App.tsx can trigger it after Pay/Storm
  const refetchAllRef = useRef(refetchAll)
  refetchAllRef.current = refetchAll
  useEffect(() => {
    if (refetchRef) refetchRef.current = () => refetchAllRef.current()
  }, [refetchRef])

  // ── Approve + Fund ──────────────────────────────────────────────────────────

  const { writeContract: approve, data: approveHash, isPending: approvePending, error: approveError } = useWriteContract()
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveHash })
  const { writeContract: fund, data: fundHash, isPending: fundPending, error: fundError } = useWriteContract()
  const { isLoading: fundConfirming, isSuccess: fundSuccess } = useWaitForTransactionReceipt({ hash: fundHash })
  const [pendingFundAmount, setPendingFundAmount] = useState<bigint | null>(null)

  const handleFund = () => {
    if (!isConnected) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID }); return }
    const raw = parseUsdc(depositAmount)
    if (!raw) return
    setPendingFundAmount(raw)
    approve({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'approve', args: [vaultAddress, raw] })
  }

  useEffect(() => {
    if (approveSuccess && pendingFundAmount) {
      fund({ address: vaultAddress, abi: VAULT_ABI, functionName: 'fund', args: [pendingFundAmount] })
      setPendingFundAmount(null)
    }
  }, [approveSuccess, pendingFundAmount]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (fundSuccess && fundHash) {
      try { refetchAll() } catch { /* ignore refresh errors */ }
      setDepositAmount(''); toast.success('Deposited!')
    }
  }, [fundSuccess]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (approveError) { const r = decodeWriteError(approveError); if (r !== 'CANCELLED') toast.error(`Approve failed: ${r}`) }
  }, [approveError])

  useEffect(() => {
    if (fundError) { const r = decodeWriteError(fundError); if (r !== 'CANCELLED') toast.error(`Deposit failed: ${r}`); setPendingFundAmount(null) }
  }, [fundError])

  // ── Set Budget ──────────────────────────────────────────────────────────────

  const { writeContract: setBudget, data: budgetHash, isPending: budgetPending, error: budgetError } = useWriteContract()
  const { isLoading: budgetConfirming, isSuccess: budgetSuccess } = useWaitForTransactionReceipt({ hash: budgetHash })

  const handleSetBudget = () => {
    if (!isConnected) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID }); return }
    setBudget({ address: vaultAddress, abi: VAULT_ABI, functionName: 'setBudget', args: [parseUsdc(budgetAmount)] })
  }

  useEffect(() => {
    if (budgetSuccess) {
      try { refetchAll() } catch { /* ignore refresh errors */ }
      setBudgetAmount(''); toast.success('Budget updated!')
    }
  }, [budgetSuccess]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (budgetError) { const r = decodeWriteError(budgetError); if (r !== 'CANCELLED') toast.error(`Set budget failed: ${r}`) }
  }, [budgetError])

  // ── Withdraw Unspent ────────────────────────────────────────────────────────

  const { writeContract: withdraw, data: withdrawHash, isPending: withdrawPending, error: withdrawError } = useWriteContract()
  const { isLoading: withdrawConfirming, isSuccess: withdrawSuccess } = useWaitForTransactionReceipt({ hash: withdrawHash })

  const handleWithdraw = () => {
    if (!isConnected) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID }); return }
    withdraw({ address: vaultAddress, abi: VAULT_ABI, functionName: 'withdrawUnspent' })
  }

  useEffect(() => {
    if (withdrawSuccess) {
      try { refetchAll() } catch { /* ignore refresh errors */ }
      toast.success('Unspent funds withdrawn!')
    }
  }, [withdrawSuccess]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (withdrawError) { const r = decodeWriteError(withdrawError); if (r !== 'CANCELLED') toast.error(`Withdraw failed: ${r}`) }
  }, [withdrawError])

  // ── Close Out ───────────────────────────────────────────────────────────────

  const [isClosingOut, setIsClosingOut] = useState(false)
  const [closeOutHashes, setCloseOutHashes] = useState<{ setBudget?: `0x${string}`; withdraw?: `0x${string}` }>({})

  const handleCloseOut = async () => {
    if (!isConnected || !walletClient || !publicClient) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID }); return }
    if (totalPaid === undefined) { toast.error('Vault data not loaded yet'); return }
    setIsClosingOut(true); setCloseOutHashes({})
    try {
      // getFeeParams retries once and throws a clear message if it fails.
      const { maxFeePerGas, maxPriorityFeePerGas } = await getFeeParams(publicClient)

      toast.info('Step 1/2: Setting budget to totalPaid…')
      const h1 = await walletClient.writeContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'setBudget', args: [totalPaid], gas: 120_000n, maxFeePerGas, maxPriorityFeePerGas })
      await waitForReceiptWithRetry(publicClient, h1)
      setCloseOutHashes(h => ({ ...h, setBudget: h1 })); toast.success('Budget locked')
      toast.info('Step 2/2: Withdrawing unspent USDC…')
      const h2 = await walletClient.writeContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'withdrawUnspent', gas: 120_000n, maxFeePerGas, maxPriorityFeePerGas })
      await waitForReceiptWithRetry(publicClient, h2)
      setCloseOutHashes(h => ({ ...h, withdraw: h2 })); toast.success('Close out complete!')
      try { refetchAll() } catch { /* ignore refresh errors — close out itself succeeded */ }
    } catch (err) {
      const r = decodeWriteError(err); if (r !== 'CANCELLED') toast.error(`Close out failed: ${r}`)
    } finally { setIsClosingOut(false) }
  }

  const isFunding = approvePending || approveConfirming || fundPending || fundConfirming
  const isSettingBudget = budgetPending || budgetConfirming
  const isWithdrawing = withdrawPending || withdrawConfirming

  return (
    <div className="space-y-4">
      {/* Owner badge */}
      {isConnected && vaultOwner && (
        <div className="flex items-center justify-between rounded-2xl px-4 py-3"
          style={{ background: isOwner ? 'rgba(26,128,71,0.06)' : 'rgba(107,101,128,0.06)', border: `1px solid ${isOwner ? 'rgba(26,128,71,0.18)' : 'var(--border)'}` }}>
          <div className="min-w-0">
            <p className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Vault owner</p>
            <p className="mono mt-0.5 truncate text-xs" style={{ color: 'var(--ink-2)' }}>{formatAddress(vaultOwner as string)}</p>
          </div>
          <div className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
            style={{ background: isOwner ? 'rgba(26,128,71,0.12)' : 'rgba(107,101,128,0.1)', color: isOwner ? 'var(--success)' : 'var(--muted)' }}>
            {isOwner ? <><BadgeCheck className="size-3.5" /> Owner</> : <><BadgeX className="size-3.5" /> Not owner</>}
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard icon={<PiggyBank className="size-4" style={{ color: 'var(--accent)' }} />} label="Vault Balance" value={formatUsdc(vaultBalance)} sub="USDC held" />
        <StatCard icon={<Target className="size-4" style={{ color: 'var(--accent-hover)' }} />} label="Approved Budget" value={formatUsdc(approvedBudget)} sub="committed" />
        <StatCard icon={<TrendingUp className="size-4" style={{ color: 'var(--success)' }} />} label="Total Paid" value={formatUsdc(totalPaid)} sub="paid out" />
        <StatCard icon={<ShieldCheck className="size-4" style={{ color: remaining > 0n ? 'var(--success)' : 'var(--muted)' }} />} label="Remaining Budget" value={formatUsdc(remaining)} sub="available" highlight={remaining > 0n} />
      </div>

      {/* OKX Wallet warning */}
      {isOkx && isConnected && (
        <div className="flex items-start gap-3 rounded-2xl px-4 py-3 text-xs"
          style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.35)', color: '#92400e' }}>
          <AlertCircle className="size-4 mt-0.5 shrink-0 text-amber-500" />
          <span>
            <span className="font-semibold">OKX Wallet</span> currently shows Arc USDC approvals as 0 USDC and may fail to estimate fees on Arc. The real amount is shown here. For the smoothest experience use <span className="font-semibold">Rabby</span> or <span className="font-semibold">MetaMask</span>.
          </span>
        </div>
      )}

      {/* Deposit */}
      <section style={glass.card} className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <TokenUSDC size={18} variant="branded" />
          <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Deposit USDC</span>
        </div>
        {isConnected && <p className="mb-3 text-xs" style={{ color: 'var(--muted)' }}>Wallet: {formatUsdc(walletBalance)} USDC</p>}
        <AmountInput value={depositAmount} onChange={setDepositAmount} glass={glass} />
        <ActionButton onClick={handleFund} loading={isFunding} disabled={!depositAmount || isFunding} label="Approve & Deposit" isConnected={isConnected} wrongChain={wrongChain} loadingLabel={approvePending || approveConfirming ? 'Approving…' : 'Depositing…'} />
        {fundHash && <TxLink hash={fundHash} label="Deposit confirmed" />}
      </section>

      {/* Set Budget */}
      <section style={glass.card} className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target className="size-[18px]" style={{ color: 'var(--accent)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Set Approved Budget</span>
          </div>
          <OwnerOnly isOwner={isOwner} isConnected={isConnected} />
        </div>
        <AmountInput value={budgetAmount} onChange={setBudgetAmount} glass={glass} />
        <ActionButton onClick={handleSetBudget} loading={isSettingBudget} disabled={!budgetAmount || isSettingBudget || !isOwner} label="Set Budget" isConnected={isConnected} wrongChain={wrongChain} loadingLabel="Setting budget…" ownerOnly={!isOwner && isConnected && !wrongChain} />
        {budgetHash && <TxLink hash={budgetHash} label="Budget updated" />}
      </section>

      {/* Withdraw */}
      <section style={glass.card} className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowDownToLine className="size-[18px]" style={{ color: 'var(--accent)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Withdraw Unspent</span>
          </div>
          <OwnerOnly isOwner={isOwner} isConnected={isConnected} />
        </div>
        <p className="mb-4 text-xs" style={{ color: 'var(--muted)' }}>
          Withdraws <span className="mono">balance − (budget − paid)</span>
        </p>
        <ActionButton onClick={handleWithdraw} loading={isWithdrawing} disabled={isWithdrawing || (!isOwner && isConnected && !wrongChain)} label="Withdraw Unspent" isConnected={isConnected} wrongChain={wrongChain} loadingLabel="Withdrawing…" ownerOnly={!isOwner && isConnected && !wrongChain} />
        {withdrawHash && <TxLink hash={withdrawHash} label="Withdrawn" />}
      </section>

      {/* Close Out */}
      <section style={{ ...glass.card, border: '1px solid rgba(186,43,76,0.25)', background: 'rgba(254,242,242,0.7)' }} className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PackageCheck className="size-[18px]" style={{ color: 'var(--danger)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Close Out</span>
          </div>
          <OwnerOnly isOwner={isOwner} isConnected={isConnected} />
        </div>
        <p className="mb-4 text-xs" style={{ color: 'var(--muted)' }}>
          Sets budget → <span className="mono">totalPaid</span>, then withdraws all unspent USDC.
        </p>
        <button onClick={handleCloseOut} disabled={isClosingOut || !isConnected || wrongChain || (!isOwner && isConnected && !wrongChain)}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: 'var(--danger)' }}>
          {!isConnected ? 'Connect Wallet' : wrongChain ? `Switch to Arc ${NETWORK === 'mainnet' ? 'Mainnet' : 'Testnet'}` : !isOwner ? 'Owner only'
            : isClosingOut ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" />Closing out…</span>
            : 'Close Out Vault'}
        </button>
        {closeOutHashes.setBudget && <TxLink hash={closeOutHashes.setBudget} label="1. Budget locked" />}
        {closeOutHashes.withdraw && <TxLink hash={closeOutHashes.withdraw} label="2. Funds withdrawn" />}
      </section>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function AmountInput({ value, onChange, glass }: { value: string; onChange: (v: string) => void; glass: { inner: React.CSSProperties } }) {
  return (
    <div style={glass.inner} className="mb-0 p-4">
      <input inputMode="decimal" value={value}
        onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ''); if (v === '' || /^\d*\.?\d*$/.test(v)) onChange(v) }}
        placeholder="0.00"
        className="display w-full bg-transparent text-3xl font-bold tabular-nums outline-none placeholder:text-slate-300"
        style={{ color: 'var(--ink)' }} />
      <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>USDC</p>
    </div>
  )
}

function OwnerOnly({ isOwner, isConnected }: { isOwner: boolean; isConnected: boolean }) {
  if (!isConnected || isOwner) return null
  return <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: 'rgba(107,101,128,0.1)', color: 'var(--muted)' }}>Owner only</span>
}

function StatCard({ icon, label, value, sub, highlight }: { icon: React.ReactNode; label: string; value: string; sub: string; highlight?: boolean }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--surface)', border: `1px solid ${highlight ? 'rgba(26,128,71,0.25)' : 'var(--border)'}`, backdropFilter: 'blur(12px)' }}>
      <div className="mb-2 flex items-center gap-1.5">{icon}<span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>{label}</span></div>
      <div className="display text-xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{value}</div>
      <div className="mt-0.5 text-xs" style={{ color: 'var(--subtle)' }}>{sub}</div>
    </div>
  )
}

function ActionButton({ onClick, loading, disabled, label, loadingLabel, isConnected, wrongChain, ownerOnly }: {
  onClick: () => void; loading: boolean; disabled: boolean; label: string; loadingLabel: string; isConnected: boolean; wrongChain: boolean; ownerOnly?: boolean
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="mt-4 w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
      style={{ background: 'var(--accent)' }}>
      {!isConnected ? 'Connect Wallet' : wrongChain ? `Switch to Arc ${NETWORK === 'mainnet' ? 'Mainnet' : 'Testnet'}` : ownerOnly ? 'Owner only'
        : loading ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" />{loadingLabel}</span>
        : label}
    </button>
  )
}

function TxLink({ hash, label }: { hash: string; label: string }) {
  return (
    <a href={buildTxUrl(hash)} target="_blank" rel="noopener noreferrer"
      className="mt-2 inline-flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--success)' }}>
      {label} <ExternalLink className="size-3" />
    </a>
  )
}
