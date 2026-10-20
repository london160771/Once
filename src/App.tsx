/**
 * App.tsx — Once Payout Vault
 *
 * Per-user vault flow:
 * 1. User connects wallet.
 * 2. App reads getVaults(connectedWallet) from the factory.
 * 3. No vaults → "Create my vault" button.
 * 4. One or more vaults → vault picker; selected vault in URL (?vault=0x...).
 *
 * Single source of truth for wallet state: wagmi useAccount().status.
 * watchAccount re-runs vault list on account/chain change.
 * When disconnected, the app always shows only the connect-wallet card —
 * no vault data is shown without an active wallet connection.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { ConnectKitButton } from 'connectkit'
import {
  useAccount, usePublicClient, useWalletClient,
  useReadContract, useSwitchChain,
} from 'wagmi'
import { watchAccount } from '@wagmi/core'
import { decodeEventLog, type Log } from 'viem'
import { Shield, Send, Activity, Plus, ChevronDown, Loader2, ExternalLink, AlertCircle } from 'lucide-react'
import { VaultScreen } from './components/VaultScreen'
import { PayScreen, type AttemptResult } from './components/PayScreen'
import { ActivityScreen } from './components/ActivityScreen'
import { FACTORY_ADDRESS, CHAIN_ID, NETWORK, buildAddressUrl } from './onchain-config'
import { FACTORY_ABI } from './factory-abi'
import { formatAddress, getFeeParams } from './utils'
import { useIsOkxWallet } from './hooks/useIsOkxWallet'
import { toast } from 'sonner'
import { wagmiConfig } from './wagmi-config'

type Tab = 'vault' | 'pay' | 'activity'

const TABS: { id: Tab; label: string; Icon: typeof Shield }[] = [
  { id: 'vault', label: 'Vault', Icon: Shield },
  { id: 'pay', label: 'Pay', Icon: Send },
  { id: 'activity', label: 'Activity', Icon: Activity },
]

// ─── URL helpers ──────────────────────────────────────────────────────────────

function getVaultFromUrl(): `0x${string}` | null {
  const p = new URLSearchParams(window.location.search)
  const v = p.get('vault')
  if (v && /^0x[0-9a-fA-F]{40}$/.test(v)) return v as `0x${string}`
  return null
}

function setVaultInUrl(addr: `0x${string}`) {
  const url = new URL(window.location.href)
  url.searchParams.set('vault', addr)
  window.history.replaceState({}, '', url.toString())
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Single source of truth: wagmi useAccount ─────────────────────────────
  const { address, chainId, status } = useAccount()
  const isConnected   = status === 'connected'
  const isReconnecting = status === 'connecting' || status === 'reconnecting'
  const isDisconnected = status === 'disconnected'

  const { switchChain } = useSwitchChain()
  const publicClient = usePublicClient({ chainId: CHAIN_ID })
  const { data: walletClient } = useWalletClient({ chainId: CHAIN_ID })
  const wrongChain = isConnected && chainId !== CHAIN_ID

  const [tab, setTab] = useState<Tab>('vault')
  const [activityTrigger, setActivityTrigger] = useState(0)
  const [stormResults, setStormResults] = useState<AttemptResult[]>([])

  // Selected vault — initialise from URL if present
  const [selectedVault, setSelectedVault] = useState<`0x${string}` | null>(getVaultFromUrl)
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

  const triggerActivity = () => setActivityTrigger(n => n + 1)
  const handleStormResults = (results: AttemptResult[]) => { setStormResults(results); triggerActivity() }

  // Vault stat refresh — VaultScreen exposes its refetchAll via this ref
  const vaultRefetchRef = useRef<(() => void) | null>(null)
  const refetchVaultStats = useCallback(() => { vaultRefetchRef.current?.() }, [])

  // ── Read vaults for the connected wallet ─────────────────────────────────

  const { data: ownedVaults, refetch: refetchVaults } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: 'getVaults',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: CHAIN_ID,
    query: { enabled: isConnected && !!address },
  })

  const vaultList = (ownedVaults as `0x${string}`[] | undefined) ?? []

  // ── React to wallet account / chain changes (watchAccount) ──────────────
  useEffect(() => {
    const unwatch = watchAccount(wagmiConfig, {
      onChange(newAccount) {
        if (newAccount.status === 'disconnected') {
          // Clear vault immediately — no data without a wallet
          setSelectedVault(null)
          setStormResults([])
        } else if (newAccount.address !== address) {
          setStormResults([])
          void refetchVaults()
        }
      },
    })
    return unwatch
  }, [address, refetchVaults])

  // Auto-select the first vault when the list loads and nothing is selected
  useEffect(() => {
    if (selectedVault) return
    if (vaultList.length > 0) selectVault(vaultList[vaultList.length - 1])
  }, [vaultList.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectVault = useCallback((addr: `0x${string}`) => {
    setSelectedVault(addr)
    setVaultInUrl(addr)
    setIsPickerOpen(false)
    setStormResults([])
  }, [])

  // ── createVault ──────────────────────────────────────────────────────────

  const handleCreateVault = async () => {
    if (!walletClient || !publicClient) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID }); return }
    setIsCreating(true)
    try {
      let feeParams
      try {
        feeParams = await getFeeParams(publicClient)
      } catch (feeErr) {
        toast.error((feeErr as Error).message)
        setIsCreating(false)
        return
      }

      let gasLimit = 800_000n
      try {
        const estimated = await publicClient.estimateContractGas({
          address: FACTORY_ADDRESS,
          abi: FACTORY_ABI,
          functionName: 'createVault',
          account: address,
        })
        gasLimit = (estimated * 120n) / 100n
      } catch (estErr) {
        const msg = (estErr as Error)?.message ?? ''
        toast.error(`Cannot create vault: ${msg.slice(0, 120)}`)
        setIsCreating(false)
        return
      }

      const hash = await walletClient.writeContract({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI,
        functionName: 'createVault',
        gas: gasLimit,
        maxFeePerGas: feeParams.maxFeePerGas,
        maxPriorityFeePerGas: feeParams.maxPriorityFeePerGas,
      })
      toast.info('Creating vault…')
      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      let newVault: `0x${string}` | null = null
      for (const log of receipt.logs as Log[]) {
        try {
          const decoded = decodeEventLog({ abi: FACTORY_ABI, ...log })
          if (decoded.eventName === 'VaultCreated') {
            newVault = (decoded.args as { owner: `0x${string}`; vault: `0x${string}` }).vault
            break
          }
        } catch { /* skip */ }
      }

      if (!newVault) throw new Error('Could not decode VaultCreated event')
      await refetchVaults()
      selectVault(newVault)
      toast.success('Vault created!')
    } catch (err) {
      const msg = (err as Error)?.message ?? ''
      if (!msg.toLowerCase().includes('user rejected') && !msg.toLowerCase().includes('user denied')) {
        toast.error(`Create vault failed: ${msg.slice(0, 80)}`)
      }
    } finally { setIsCreating(false) }
  }

  const isOkx = useIsOkxWallet()

  // ── Render helpers ──────────────────────────────────────────────────────

  const tabBar = (
    <div className="mb-5 grid grid-cols-3 gap-1 rounded-2xl p-1"
      style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
      {TABS.map(({ id, label, Icon }) => (
        <button key={id} onClick={() => { setTab(id); refetchVaultStats() }}
          className="flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-semibold transition-all"
          style={tab === id
            ? { background: '#fff', color: 'var(--ink)', boxShadow: '0 1px 4px rgba(18,45,69,0.10)' }
            : { color: 'var(--subtle)' }}>
          <Icon className="size-3.5" />{label}
        </button>
      ))}
    </div>
  )

  const screens = () => (
    <>
      <div style={{ display: tab === 'vault' ? 'block' : 'none' }}>
        <VaultScreen
          vaultAddress={selectedVault!}
          refetchRef={vaultRefetchRef}
        />
      </div>
      <div style={{ display: tab === 'pay' ? 'block' : 'none' }}>
        <PayScreen
          vaultAddress={selectedVault!}
          onActivity={triggerActivity}
          onStormResults={handleStormResults}
          onTxConfirmed={refetchVaultStats}
        />
      </div>
      <div style={{ display: tab === 'activity' ? 'block' : 'none' }}>
        <ActivityScreen vaultAddress={selectedVault!} refreshTrigger={activityTrigger} stormResults={stormResults} />
      </div>
    </>
  )

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      <div className="mx-auto max-w-md px-4 pb-24 pt-6">

        {/* Header */}
        <header className="mb-6 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="display text-2xl font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}>Once</h1>
              <span className="rounded-full px-2 py-0.5 text-xs font-semibold"
                style={NETWORK === 'mainnet'
                  ? { background: 'rgba(26,128,71,0.1)', color: 'var(--success)', border: '1px solid rgba(26,128,71,0.2)' }
                  : { background: 'rgba(99,102,241,0.1)', color: '#6366f1', border: '1px solid rgba(99,102,241,0.25)' }}>
                {NETWORK === 'mainnet' ? 'MAINNET' : 'TESTNET'}
              </span>
            </div>
            {selectedVault ? (
              <a href={buildAddressUrl(selectedVault)} target="_blank" rel="noopener noreferrer"
                className="mono flex items-center gap-1 text-xs" style={{ color: 'var(--muted)' }}>
                {formatAddress(selectedVault)} <ExternalLink className="size-3" />
              </a>
            ) : (
              <a href={buildAddressUrl(FACTORY_ADDRESS)} target="_blank" rel="noopener noreferrer"
                className="mono flex items-center gap-1 text-xs" style={{ color: 'var(--muted)' }}>
                factory: {formatAddress(FACTORY_ADDRESS)} <ExternalLink className="size-3" />
              </a>
            )}
          </div>
          {/* ConnectKitButton is always the single connect/disconnect UI */}
          <ConnectKitButton />
        </header>

        {/* Tagline */}
        <div className="mb-5 rounded-2xl px-4 py-3 text-xs" style={{ background: 'rgba(18,45,69,0.04)', border: '1px solid var(--border)' }}>
          <span className="font-semibold" style={{ color: 'var(--ink-2)' }}>Idempotent USDC payouts.</span>{' '}
          <span style={{ color: 'var(--muted)' }}>Every intent paid exactly once — no double-spends, no over-budget surprises, even under retries.</span>
        </div>

        {/* Connecting / reconnecting state */}
        {isReconnecting && (
          <div className="mb-4 flex items-center gap-2 rounded-2xl px-4 py-3 text-xs"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
            <Loader2 className="size-4 animate-spin shrink-0" />
            Connecting wallet…
          </div>
        )}

        {/* Wrong chain banner */}
        {wrongChain && (
          <div className="mb-5 rounded-2xl px-4 py-3 text-center text-sm" style={{ background: 'rgba(186,43,76,0.07)', border: '1px solid rgba(186,43,76,0.2)', color: 'var(--danger)' }}>
            Switch to Arc {NETWORK === 'mainnet' ? 'Mainnet' : 'Testnet'} to continue
          </div>
        )}

        {/* Vault picker / create prompt — only when connected and on correct chain */}
        {isConnected && !wrongChain && (
          <div className="mb-5">
            {vaultList.length === 0 ? (
              <div className="rounded-2xl p-5 text-center" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <p className="text-sm font-semibold mb-1" style={{ color: 'var(--ink)' }}>You don't have a vault yet</p>
                <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>Deploy your own OncePayoutVault — owned by your wallet, funded by you.</p>
                {isOkx && (
                  <div className="mb-4 flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs text-left"
                    style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.35)', color: '#92400e' }}>
                    <AlertCircle className="size-3.5 mt-0.5 shrink-0 text-amber-500" />
                    <span><span className="font-semibold">OKX Wallet</span> may fail to estimate fees for creating a vault on Arc. Use <span className="font-semibold">Rabby</span> or <span className="font-semibold">MetaMask</span> for the smoothest experience.</span>
                  </div>
                )}
                <button onClick={handleCreateVault} disabled={isCreating}
                  className="inline-flex items-center gap-2 rounded-2xl px-6 py-3 text-sm font-semibold text-white transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40"
                  style={{ background: 'var(--accent)' }}>
                  {isCreating
                    ? <><Loader2 className="size-4 animate-spin" />Creating vault…</>
                    : <><Plus className="size-4" />Create my vault</>}
                </button>
              </div>
            ) : (
              <div className="relative">
                <button onClick={() => setIsPickerOpen(o => !o)}
                  className="flex w-full items-center justify-between rounded-2xl px-4 py-3 text-sm transition hover:opacity-80"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <div className="flex items-center gap-2 min-w-0">
                    <Shield className="size-4 shrink-0" style={{ color: 'var(--accent)' }} />
                    <span className="mono truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>
                      {selectedVault ? formatAddress(selectedVault) : 'Select a vault'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={e => { e.stopPropagation(); handleCreateVault() }} disabled={isCreating}
                      className="flex items-center gap-1 rounded-xl px-2.5 py-1 text-xs font-medium transition hover:opacity-80 disabled:opacity-40"
                      style={{ background: 'var(--surface-muted)', color: 'var(--accent)' }}>
                      {isCreating ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                      New
                    </button>
                    <ChevronDown className={`size-4 transition-transform ${isPickerOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--muted)' }} />
                  </div>
                </button>

                {isPickerOpen && (
                  <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-2xl shadow-lg overflow-hidden"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    {[...vaultList].reverse().map((v, i) => (
                      <button key={v} onClick={() => selectVault(v)}
                        className="flex w-full items-center justify-between px-4 py-3 text-left text-xs transition hover:opacity-80"
                        style={{
                          borderBottom: i < vaultList.length - 1 ? '1px solid var(--border)' : 'none',
                          background: v === selectedVault ? 'rgba(18,45,69,0.04)' : 'transparent',
                        }}>
                        <span className="mono font-medium" style={{ color: 'var(--ink)' }}>{formatAddress(v)}</span>
                        <div className="flex items-center gap-2">
                          {v === selectedVault && <span className="text-xs" style={{ color: 'var(--accent)' }}>active</span>}
                          <a href={buildAddressUrl(v)} target="_blank" rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="flex items-center gap-0.5" style={{ color: 'var(--muted)' }}>
                            <ExternalLink className="size-3" />
                          </a>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Vault screens — connected with a vault */}
        {isConnected && !wrongChain && selectedVault && (
          <>
            {tabBar}
            {screens()}
          </>
        )}

        {/* Disconnected — always show connect-wallet card, never vault data */}
        {!isConnected && !isReconnecting && (
          <div className="rounded-2xl p-8 text-center" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <Shield className="size-10 mx-auto mb-3" style={{ color: 'var(--border-strong)' }} />
            <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Connect your wallet</p>
            <p className="mt-1 text-xs mb-5" style={{ color: 'var(--muted)' }}>Connect to create or manage your vault.</p>
            <ConnectKitButton />
          </div>
        )}

      </div>
    </div>
  )
}
