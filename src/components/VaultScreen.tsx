import { useState } from 'react'
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi'
import { erc20Abi } from 'viem'
import { Loader2, ShieldCheck, PiggyBank, Target, TrendingUp, ArrowDownToLine } from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'
import { VAULT_ADDRESS, USDC_ADDRESS, CHAIN_ID, buildTxUrl } from '../onchain-config'
import { VAULT_ABI } from '../vault-abi'
import { formatUsdc, parseUsdc } from '../utils'
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

export function VaultScreen() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain } = useSwitchChain()
  const wrongChain = isConnected && chainId !== CHAIN_ID

  const [depositAmount, setDepositAmount] = useState('')
  const [budgetAmount, setBudgetAmount] = useState('')

  // ── Contract reads ──────────────────────────────────────────────────────────
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

  // ── Approve + Fund ──────────────────────────────────────────────────────────
  const { writeContract: approve, data: approveHash, isPending: approvePending } = useWriteContract()
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveHash })

  const { writeContract: fund, data: fundHash, isPending: fundPending } = useWriteContract()
  const { isLoading: fundConfirming, isSuccess: fundSuccess } = useWaitForTransactionReceipt({ hash: fundHash })

  // Watch for approve success to trigger fund
  const [pendingFundAmount, setPendingFundAmount] = useState<bigint | null>(null)
  const handleFund = () => {
    if (!isConnected) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID as 5042002 }); return }
    const raw = parseUsdc(depositAmount)
    if (!raw) return
    setPendingFundAmount(raw)
    approve({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'approve', args: [VAULT_ADDRESS, raw] })
  }

  // Auto-fund after approval confirms
  if (approveSuccess && pendingFundAmount) {
    fund({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'fund', args: [pendingFundAmount] })
    setPendingFundAmount(null)
  }

  if (fundSuccess) {
    refetchBalance(); refetchBudget(); refetchPaid()
    if (fundHash) toast.success(`Funded! tx: ${fundHash.slice(0, 10)}…`)
  }

  // ── Set Budget ──────────────────────────────────────────────────────────────
  const { writeContract: setBudget, data: budgetHash, isPending: budgetPending } = useWriteContract()
  const { isLoading: budgetConfirming, isSuccess: budgetSuccess } = useWaitForTransactionReceipt({ hash: budgetHash })

  const handleSetBudget = () => {
    if (!isConnected) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID as 5042002 }); return }
    const raw = parseUsdc(budgetAmount)
    setBudget({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'setBudget', args: [raw] })
  }

  if (budgetSuccess) {
    refetchBudget(); refetchPaid()
    if (budgetHash) toast.success(`Budget updated!`)
  }

  // ── Withdraw ────────────────────────────────────────────────────────────────
  const { writeContract: withdraw, data: withdrawHash, isPending: withdrawPending } = useWriteContract()
  const { isLoading: withdrawConfirming, isSuccess: withdrawSuccess } = useWaitForTransactionReceipt({ hash: withdrawHash })

  const handleWithdraw = () => {
    if (!isConnected) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID as 5042002 }); return }
    withdraw({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'withdrawUnspent' })
  }

  if (withdrawSuccess) {
    refetchBalance(); refetchBudget(); refetchPaid()
    if (withdrawHash) toast.success('Unspent funds withdrawn!')
  }

  const isFunding = approvePending || approveConfirming || fundPending || fundConfirming
  const isSettingBudget = budgetPending || budgetConfirming
  const isWithdrawing = withdrawPending || withdrawConfirming

  return (
    <div className="space-y-4">
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
          loadingLabel={approvePending || approveConfirming ? 'Approving…' : 'Funding…'}
        />
        {fundHash && (
          <TxLink hash={fundHash} label="Deposit confirmed" />
        )}
      </section>

      {/* Set Budget */}
      <section style={glass.card} className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Target className="size-[18px]" style={{ color: 'var(--accent)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Set Approved Budget</span>
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
          disabled={!budgetAmount || isSettingBudget}
          label="Set Budget"
          isConnected={isConnected}
          wrongChain={wrongChain}
          loadingLabel="Setting budget…"
        />
        {budgetHash && <TxLink hash={budgetHash} label="Budget updated" />}
      </section>

      {/* Withdraw */}
      <section style={glass.card} className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <ArrowDownToLine className="size-[18px]" style={{ color: 'var(--accent)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Withdraw Unspent</span>
        </div>
        <p className="mb-4 text-xs" style={{ color: 'var(--muted)' }}>
          Withdraws vault balance minus uncommitted budget (balance − (budget − paid)).
        </p>
        <ActionButton
          onClick={handleWithdraw}
          loading={isWithdrawing}
          disabled={isWithdrawing}
          label="Withdraw Unspent"
          isConnected={isConnected}
          wrongChain={wrongChain}
          loadingLabel="Withdrawing…"
        />
        {withdrawHash && <TxLink hash={withdrawHash} label="Withdrawn" />}
      </section>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function ActionButton({ onClick, loading, disabled, label, loadingLabel, isConnected, wrongChain }: {
  onClick: () => void
  loading: boolean
  disabled: boolean
  label: string
  loadingLabel: string
  isConnected: boolean
  wrongChain: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="mt-4 w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
      style={{ background: 'var(--accent)' }}
    >
      {!isConnected ? 'Connect Wallet' : wrongChain ? 'Switch to Arc Testnet' : loading ? (
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
      {label} ↗
    </a>
  )
}
