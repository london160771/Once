/**
 * VaultScreen — deposit, set budget, withdraw, and close out.
 *
 * Bug fixes applied:
 * 1. useEffect hooks keyed on receipt success so each fires exactly once.
 *    No side-effects in the render body.
 * 2. Owner address read from chain; owner badge shown; owner-only buttons
 *    disabled for non-owners with a clear tooltip.
 * 3. All write errors decoded to human-readable reason codes and shown as
 *    toast.error with consistent messages.
 */

import { useState, useEffect } from 'react'
import {
  useAccount, useReadContract, useWriteContract,
  useWaitForTransactionReceipt, useSwitchChain,
  useWalletClient, usePublicClient,
} from 'wagmi'
import { erc20Abi, decodeErrorResult } from 'viem'
import {
  Loader2, ShieldCheck, PiggyBank, Target, TrendingUp,
  ArrowDownToLine, PackageCheck, ExternalLink, BadgeCheck, BadgeX,
} from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'
import { VAULT_ADDRESS, USDC_ADDRESS, CHAIN_ID, buildTxUrl } from '../onchain-config'
import { VAULT_ABI } from '../vault-abi'
import { formatUsdc, parseUsdc, formatAddress } from '../utils'
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

  // User cancelled in wallet
  if (msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('user denied')) {
    return 'CANCELLED'
  }

  // Custom error codes in message
  for (const code of Object.keys(FRIENDLY)) {
    if (msg.includes(code)) return FRIENDLY[code] ?? code
  }

  // ABI-decoded custom error from revert data
  const data = (err as { data?: `0x${string}` })?.data
  if (data && data !== '0x') {
    try {
      const decoded = decodeErrorResult({ abi: VAULT_ABI, data })
      return FRIENDLY[decoded.errorName] ?? decoded.errorName
    } catch { /* fall through */ }
  }

  // Trim long Solidity error strings
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

export function VaultScreen() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain } = useSwitchChain()
  const { data: walletClient } = useWalletClient({ chainId: CHAIN_ID })
  const publicClient = usePublicClient({ chainId: CHAIN_ID })
  const wrongChain = isConnected && chainId !== CHAIN_ID

  const [depositAmount, setDepositAmount] = useState('')
  const [budgetAmount, setBudgetAmount] = useState('')

  // ── Contract reads ──────────────────────────────────────────────────────────

  const { data: vaultOwner } = useReadContract({
    address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'owner', chainId: CHAIN_ID,
  })
  const isOwner = !!(address && vaultOwner && address.toLowerCase() === (vaultOwner as string).toLowerCase())

  const { data: vaultBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf',
    args: [VAULT_ADDRESS], chainId: CHAIN_ID,
  })
  const { data: walletBalance } = useReadContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'], chainId: CHAIN_ID,
    query: { enabled: !!address },
  })
  const { data: approvedBudget, refetch: refetchBudget } = useReadContract({
    address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'approvedBudget', chainId: CHAIN_ID,
  })
  const { data: totalPaid, refetch: refetchPaid } = useReadContract({
    address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'totalPaid', chainId: CHAIN_ID,
  })

  const remaining = (approvedBudget ?? 0n) - (totalPaid ?? 0n)

  const refetchAll = () => { refetchBalance(); refetchBudget(); refetchPaid() }

  // ── Approve + Fund ──────────────────────────────────────────────────────────
  // Two-step: approve USDC spend, then call vault.fund().
  // All side-effects are in useEffect to prevent double-firing on re-render.

  const { writeContract: approve, data: approveHash, isPending: approvePending, error: approveError } = useWriteContract()
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveHash })
  const { writeContract: fund, data: fundHash, isPending: fundPending, error: fundError } = useWriteContract()
  const { isLoading: fundConfirming, isSuccess: fundSuccess } = useWaitForTransactionReceipt({ hash: fundHash })

  // pendingFundAmount is set when approve is submitted; cleared once fund fires.
  const [pendingFundAmount, setPendingFundAmount] = useState<bigint | null>(null)

  const handleFund = () => {
    if (!isConnected) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID as 5042002 }); return }
    const raw = parseUsdc(depositAmount)
    if (!raw) return
    setPendingFundAmount(raw)
    approve({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: 'approve',
      args: [VAULT_ADDRESS, raw],
    })
  }

  // Fire fund() exactly once after approve confirms
  useEffect(() => {
    if (approveSuccess && pendingFundAmount) {
      fund({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'fund', args: [pendingFundAmount] })
      setPendingFundAmount(null)
    }
  }, [approveSuccess, pendingFundAmount]) // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch + toast exactly once after fund confirms
  useEffect(() => {
    if (fundSuccess && fundHash) {
      refetchAll()
      setDepositAmount('')
      toast.success('Deposited successfully!')
    }
  }, [fundSuccess]) // eslint-disable-line react-hooks/exhaustive-deps

  // Error toasts
  useEffect(() => {
    if (approveError) {
      const reason = decodeWriteError(approveError)
      if (reason !== 'CANCELLED') toast.error(`Approve failed: ${reason}`)
    }
  }, [approveError])

  useEffect(() => {
    if (fundError) {
      const reason = decodeWriteError(fundError)
      if (reason !== 'CANCELLED') toast.error(`Deposit failed: ${reason}`)
      setPendingFundAmount(null)
    }
  }, [fundError])

  // ── Set Budget ──────────────────────────────────────────────────────────────

  const { writeContract: setBudget, data: budgetHash, isPending: budgetPending, error: budgetError } = useWriteContract()
  const { isLoading: budgetConfirming, isSuccess: budgetSuccess } = useWaitForTransactionReceipt({ hash: budgetHash })

  const handleSetBudget = () => {
    if (!isConnected) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID as 5042002 }); return }
    const raw = parseUsdc(budgetAmount)
    setBudget({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'setBudget', args: [raw] })
  }

  useEffect(() => {
    if (budgetSuccess) {
      refetchAll()
      setBudgetAmount('')
      toast.success('Budget updated!')
    }
  }, [budgetSuccess]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (budgetError) {
      const reason = decodeWriteError(budgetError)
      if (reason !== 'CANCELLED') toast.error(`Set budget failed: ${reason}`)
    }
  }, [budgetError])

  // ── Withdraw Unspent ────────────────────────────────────────────────────────

  const { writeContract: withdraw, data: withdrawHash, isPending: withdrawPending, error: withdrawError } = useWriteContract()
  const { isLoading: withdrawConfirming, isSuccess: withdrawSuccess } = useWaitForTransactionReceipt({ hash: withdrawHash })

  const handleWithdraw = () => {
    if (!isConnected) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID as 5042002 }); return }
    withdraw({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'withdrawUnspent' })
  }

  useEffect(() => {
    if (withdrawSuccess) {
      refetchAll()
      toast.success('Unspent funds withdrawn!')
    }
  }, [withdrawSuccess]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (withdrawError) {
      const reason = decodeWriteError(withdrawError)
      if (reason !== 'CANCELLED') toast.error(`Withdraw failed: ${reason}`)
    }
  }, [withdrawError])

  // ── Close Out: setBudget(totalPaid) then withdrawUnspent ────────────────────

  const [isClosingOut, setIsClosingOut] = useState(false)
  const [closeOutHashes, setCloseOutHashes] = useState<{ setBudget?: `0x${string}`; withdraw?: `0x${string}` }>({})

  const handleCloseOut = async () => {
    if (!isConnected || !walletClient || !publicClient) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID as 5042002 }); return }
    if (totalPaid === undefined) { toast.error('Vault data not loaded yet'); return }

    setIsClosingOut(true)
    setCloseOutHashes({})

    try {
      toast.info('Step 1/2: Setting budget to totalPaid…')
      const setBudgetHash = await walletClient.writeContract({
        address: VAULT_ADDRESS, abi: VAULT_ABI,
        functionName: 'setBudget', args: [totalPaid], gas: 100_000n,
      })
      await publicClient.waitForTransactionReceipt({ hash: setBudgetHash })
      setCloseOutHashes(h => ({ ...h, setBudget: setBudgetHash }))
      toast.success('Budget locked to totalPaid')

      toast.info('Step 2/2: Withdrawing unspent USDC…')
      const wHash = await walletClient.writeContract({
        address: VAULT_ADDRESS, abi: VAULT_ABI,
        functionName: 'withdrawUnspent', gas: 100_000n,
      })
      await publicClient.waitForTransactionReceipt({ hash: wHash })
      setCloseOutHashes(h => ({ ...h, withdraw: wHash }))
      toast.success('Close out complete — unspent USDC returned!')
      refetchAll()
    } catch (err) {
      const reason = decodeWriteError(err)
      if (reason !== 'CANCELLED') toast.error(`Close out failed: ${reason}`)
    } finally {
      setIsClosingOut(false)
    }
  }

  const isFunding = approvePending || approveConfirming || fundPending || fundConfirming
  const isSettingBudget = budgetPending || budgetConfirming
  const isWithdrawing = withdrawPending || withdrawConfirming

  return (
    <div className="space-y-4">

      {/* Owner badge */}
      {isConnected && vaultOwner && (
        <div
          className="flex items-center justify-between rounded-2xl px-4 py-3"
          style={{
            background: isOwner ? 'rgba(26,128,71,0.06)' : 'rgba(107,101,128,0.06)',
            border: `1px solid ${isOwner ? 'rgba(26,128,71,0.18)' : 'var(--border)'}`,
          }}
        >
          <div className="min-w-0">
            <p className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Vault owner</p>
            <p className="mono mt-0.5 truncate text-xs" style={{ color: 'var(--ink-2)' }}>
              {formatAddress(vaultOwner as string)}
            </p>
          </div>
          <div
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
            style={{
              background: isOwner ? 'rgba(26,128,71,0.12)' : 'rgba(107,101,128,0.1)',
              color: isOwner ? 'var(--success)' : 'var(--muted)',
            }}
          >
            {isOwner
              ? <><BadgeCheck className="size-3.5" /> Owner</>
              : <><BadgeX className="size-3.5" /> Not owner</>
            }
          </div>
        </div>
      )}

      {/* Hero stats */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={<PiggyBank className="size-4" style={{ color: 'var(--accent)' }} />}
          label="Vault Balance"
          value={formatUsdc(vaultBalance)}
          sub="USDC held"
        />
        <StatCard
          icon={<Target className="size-4" style={{ color: 'var(--accent-hover)' }} />}
          label="Approved Budget"
          value={formatUsdc(approvedBudget)}
          sub="committed"
        />
        <StatCard
          icon={<TrendingUp className="size-4" style={{ color: 'var(--success)' }} />}
          label="Total Paid"
          value={formatUsdc(totalPaid)}
          sub="paid out"
        />
        <StatCard
          icon={<ShieldCheck className="size-4" style={{ color: remaining > 0n ? 'var(--success)' : 'var(--muted)' }} />}
          label="Remaining Budget"
          value={formatUsdc(remaining)}
          sub="available"
          highlight={remaining > 0n}
        />
      </div>

      {/* Deposit */}
      <section style={glass.card} className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <TokenUSDC size={18} variant="branded" />
          <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Deposit USDC</span>
        </div>
        {isConnected && (
          <p className="mb-3 text-xs" style={{ color: 'var(--muted)' }}>
            Wallet: {formatUsdc(walletBalance)} USDC
          </p>
        )}
        <div style={glass.inner} className="p-4">
          <input
            inputMode="decimal"
            value={depositAmount}
            onChange={e => {
              const v = e.target.value.replace(/[^0-9.]/g, '')
              if (v === '' || /^\d*\.?\d*$/.test(v)) setDepositAmount(v)
            }}
            placeholder="0.00"
            className="display w-full bg-transparent text-3xl font-bold tabular-nums outline-none placeholder:text-slate-300"
            style={{ color: 'var(--ink)' }}
          />
          <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>USDC</p>
        </div>
        <ActionButton
          onClick={handleFund}
          loading={isFunding}
          disabled={!depositAmount || isFunding}
          label="Approve & Deposit"
          isConnected={isConnected}
          wrongChain={wrongChain}
          loadingLabel={approvePending || approveConfirming ? 'Approving…' : 'Depositing…'}
        />
        {fundHash && <TxLink hash={fundHash} label="Deposit confirmed" />}
      </section>

      {/* Set Budget — owner only */}
      <section style={glass.card} className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target className="size-[18px]" style={{ color: 'var(--accent)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Set Approved Budget</span>
          </div>
          <OwnerOnly isOwner={isOwner} isConnected={isConnected} />
        </div>
        <div style={glass.inner} className="p-4">
          <input
            inputMode="decimal"
            value={budgetAmount}
            onChange={e => {
              const v = e.target.value.replace(/[^0-9.]/g, '')
              if (v === '' || /^\d*\.?\d*$/.test(v)) setBudgetAmount(v)
            }}
            placeholder="0.00"
            className="display w-full bg-transparent text-3xl font-bold tabular-nums outline-none placeholder:text-slate-300"
            style={{ color: 'var(--ink)' }}
          />
          <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>USDC</p>
        </div>
        <ActionButton
          onClick={handleSetBudget}
          loading={isSettingBudget}
          disabled={!budgetAmount || isSettingBudget || !isOwner}
          label="Set Budget"
          isConnected={isConnected}
          wrongChain={wrongChain}
          loadingLabel="Setting budget…"
          ownerOnly={!isOwner && isConnected && !wrongChain}
        />
        {budgetHash && <TxLink hash={budgetHash} label="Budget updated" />}
      </section>

      {/* Withdraw Unspent — owner only */}
      <section style={glass.card} className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowDownToLine className="size-[18px]" style={{ color: 'var(--accent)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Withdraw Unspent</span>
          </div>
          <OwnerOnly isOwner={isOwner} isConnected={isConnected} />
        </div>
        <p className="mb-4 text-xs" style={{ color: 'var(--muted)' }}>
          Withdraws vault balance minus the committed-but-unpaid budget<br />
          <span className="mono">withdrawable = balance − (budget − paid)</span>
        </p>
        <ActionButton
          onClick={handleWithdraw}
          loading={isWithdrawing}
          disabled={isWithdrawing || (!isOwner && isConnected && !wrongChain)}
          label="Withdraw Unspent"
          isConnected={isConnected}
          wrongChain={wrongChain}
          loadingLabel="Withdrawing…"
          ownerOnly={!isOwner && isConnected && !wrongChain}
        />
        {withdrawHash && <TxLink hash={withdrawHash} label="Withdrawn" />}
      </section>

      {/* Close Out — owner only */}
      <section
        style={{ ...glass.card, border: '1px solid rgba(186,43,76,0.25)', background: 'rgba(254,242,242,0.7)' }}
        className="p-5"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PackageCheck className="size-[18px]" style={{ color: 'var(--danger)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Close Out</span>
          </div>
          <OwnerOnly isOwner={isOwner} isConnected={isConnected} />
        </div>
        <p className="mb-4 text-xs" style={{ color: 'var(--muted)' }}>
          Two-step atomic close: sets budget down to <span className="mono">totalPaid</span> (locking the committed amount), then withdraws all remaining USDC back to your wallet.
        </p>
        <button
          onClick={handleCloseOut}
          disabled={isClosingOut || !isConnected || wrongChain || (!isOwner && isConnected && !wrongChain)}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: 'var(--danger)' }}
        >
          {!isConnected ? 'Connect Wallet'
            : wrongChain ? 'Switch to Arc Testnet'
            : !isOwner ? 'Owner only'
            : isClosingOut
              ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" />Closing out…</span>
              : 'Close Out Vault'}
        </button>
        {closeOutHashes.setBudget && <TxLink hash={closeOutHashes.setBudget} label="1. Budget locked" />}
        {closeOutHashes.withdraw && <TxLink hash={closeOutHashes.withdraw} label="2. Funds withdrawn" />}
      </section>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function OwnerOnly({ isOwner, isConnected }: { isOwner: boolean; isConnected: boolean }) {
  if (!isConnected || isOwner) return null
  return (
    <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: 'rgba(107,101,128,0.1)', color: 'var(--muted)' }}>
      Owner only
    </span>
  )
}

function StatCard({ icon, label, value, sub, highlight }: {
  icon: React.ReactNode
  label: string
  value: string
  sub: string
  highlight?: boolean
}) {
  return (
    <div
      className="rounded-2xl p-4"
      style={{
        background: 'var(--surface)',
        border: `1px solid ${highlight ? 'rgba(26,128,71,0.25)' : 'var(--border)'}`,
        backdropFilter: 'blur(12px)',
      }}
    >
      <div className="mb-2 flex items-center gap-1.5">
        {icon}
        <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>{label}</span>
      </div>
      <div className="display text-xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{value}</div>
      <div className="mt-0.5 text-xs" style={{ color: 'var(--subtle)' }}>{sub}</div>
    </div>
  )
}

function ActionButton({ onClick, loading, disabled, label, loadingLabel, isConnected, wrongChain, ownerOnly }: {
  onClick: () => void
  loading: boolean
  disabled: boolean
  label: string
  loadingLabel: string
  isConnected: boolean
  wrongChain: boolean
  ownerOnly?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="mt-4 w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
      style={{ background: 'var(--accent)' }}
    >
      {!isConnected ? 'Connect Wallet'
        : wrongChain ? 'Switch to Arc Testnet'
        : ownerOnly ? 'Owner only'
        : loading ? (
          <span className="flex items-center justify-center gap-2">
            <Loader2 className="size-4 animate-spin" />{loadingLabel}
          </span>
        ) : label}
    </button>
  )
}

function TxLink({ hash, label }: { hash: string; label: string }) {
  return (
    <a
      href={buildTxUrl(hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 inline-flex items-center gap-1 text-xs font-medium"
      style={{ color: 'var(--success)' }}
    >
      {label} <ExternalLink className="size-3" />
    </a>
  )
}
