/**
 * App.tsx — Once Payout Vault
 *
 * Per-user vault flow:
 * 1. User connects wallet.
 * 2. App reads getVaults(connectedWallet) from the factory.
 * 3. No vaults → "Create my vault" button → calls createVault(), waits for
 *    receipt, extracts vault address from logs, selects it.
 * 4. One or more vaults → vault picker dropdown in the header.
 * 5. Selected vault is persisted in the URL (?vault=0x...) so shareable
 *    read-only links work without a wallet.
 * 6. All three screens receive the selected vault address as a prop.
 *
 * No vault address is hardcoded here or in onchain-config.ts.
 */

import { useState, useEffect, useCallback } from 'react'
import { ConnectKitButton } from 'connectkit'
import { useAccount, usePublicClient, useWalletClient, useReadContract, useSwitchChain } from 'wagmi'
import { decodeEventLog, type Log } from 'viem'
import { Shield, Send, Activity, Plus, ChevronDown, Loader2, ExternalLink } from 'lucide-react'
import { VaultScreen } from './components/VaultScreen'
import { PayScreen, type AttemptResult } from './components/PayScreen'
import { ActivityScreen } from './components/ActivityScreen'
import { FACTORY_ADDRESS, CHAIN_ID, EXPLORER_BASE, buildAddressUrl } from './onchain-config'
import { FACTORY_ABI } from './factory-abi'
import { formatAddress } from './utils'
import { toast } from 'sonner'

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
  const { address, chainId, isConnected } = useAccount()
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

  // Factory: createVault state
  const [isCreating, setIsCreating] = useState(false)

  const triggerActivity = () => setActivityTrigger(n => n + 1)
  const handleStormResults = (results: AttemptResult[]) => { setStormResults(results); triggerActivity() }

  // ── Read vaults for the connected wallet ─────────────────────────────────────

  const { data: ownedVaults, refetch: refetchVaults } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: 'getVaults',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: CHAIN_ID,
    query: { enabled: !!address },
  })

  const vaultList = (ownedVaults as `0x${string}`[] | undefined) ?? []

  // Auto-select the first vault when the list loads and nothing is selected
  useEffect(() => {
    if (selectedVault) return   // URL or already chosen
    if (vaultList.length > 0) {
      selectVault(vaultList[vaultList.length - 1]) // pick most recently created
    }
  }, [vaultList.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectVault = useCallback((addr: `0x${string}`) => {
    setSelectedVault(addr)
    setVaultInUrl(addr)
    setIsPickerOpen(false)
    setStormResults([])
  }, [])

  // ── createVault ──────────────────────────────────────────────────────────────

  const handleCreateVault = async () => {
    if (!walletClient || !publicClient) return
    if (wrongChain) { switchChain({ chainId: CHAIN_ID as 5042002 }); return }
    setIsCreating(true)
    try {
      // Pre-estimate gas so wallets that can't auto-estimate (e.g. OKX on Arc
      // Testnet) still see a valid network fee. Add 20 % buffer.
      let gasLimit = 800_000n
      let feeData: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint } = {}
      try {
        const [estimated, fees] = await Promise.all([
          publicClient.estimateContractGas({
            address: FACTORY_ADDRESS,
            abi: FACTORY_ABI,
            functionName: 'createVault',
            account: address,
          }),
          publicClient.estimateFeesPerGas(),
        ])
        gasLimit = (estimated * 120n) / 100n  // +20 %
        feeData = fees.maxFeePerGas != null
          ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n }
          : { maxFeePerGas: fees.gasPrice ?? 30_000_000_000n, maxPriorityFeePerGas: 0n }
      } catch (estErr) {
        // Estimation itself reverted — decode and show reason, abort
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
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      })
      toast.info('Creating vault…')
      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      // Decode VaultCreated event to get the vault address
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

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      <div className="mx-auto max-w-md px-4 pb-24 pt-6">

        {/* Header */}
        <header className="mb-6 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="display text-2xl font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}>Once</h1>
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
          <ConnectKitButton />
        </header>

        {/* Tagline */}
        <div className="mb-5 rounded-2xl px-4 py-3 text-xs" style={{ background: 'rgba(18,45,69,0.04)', border: '1px solid var(--border)' }}>
          <span className="font-semibold" style={{ color: 'var(--ink-2)' }}>Idempotent USDC payouts.</span>
          {' '}
          <span style={{ color: 'var(--muted)' }}>Every intent paid exactly once — no double-spends, no over-budget surprises, even under retries.</span>
        </div>

        {/* ── Vault picker / create prompt ─────────────────────────────────── */}
        {isConnected && !wrongChain && (
          <div className="mb-5">
            {vaultList.length === 0 ? (
              /* No vaults — prompt to create */
              <div className="rounded-2xl p-5 text-center" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <p className="text-sm font-semibold mb-1" style={{ color: 'var(--ink)' }}>You don't have a vault yet</p>
                <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>Deploy your own OncePayoutVault — owned by your wallet, funded by you.</p>
                <button onClick={handleCreateVault} disabled={isCreating}
                  className="inline-flex items-center gap-2 rounded-2xl px-6 py-3 text-sm font-semibold text-white transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40"
                  style={{ background: 'var(--accent)' }}>
                  {isCreating
                    ? <><Loader2 className="size-4 animate-spin" />Creating vault…</>
                    : <><Plus className="size-4" />Create my vault</>}
                </button>
              </div>
            ) : (
              /* Has vaults — picker */
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

        {/* Wrong chain banner */}
        {wrongChain && (
          <div className="mb-5 rounded-2xl px-4 py-3 text-center text-sm" style={{ background: 'rgba(186,43,76,0.07)', border: '1px solid rgba(186,43,76,0.2)', color: 'var(--danger)' }}>
            Switch to Arc Testnet to continue
          </div>
        )}

        {/* Tab bar — only shown when a vault is selected */}
        {selectedVault && (
          <>
            <div className="mb-5 grid grid-cols-3 gap-1 rounded-2xl p-1"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
              {TABS.map(({ id, label, Icon }) => (
                <button key={id} onClick={() => setTab(id)}
                  className="flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-semibold transition-all"
                  style={tab === id
                    ? { background: '#fff', color: 'var(--ink)', boxShadow: '0 1px 4px rgba(18,45,69,0.10)' }
                    : { color: 'var(--subtle)' }}>
                  <Icon className="size-3.5" />{label}
                </button>
              ))}
            </div>

            {/* Screens — keep all mounted so state persists across tab switches */}
            <div style={{ display: tab === 'vault' ? 'block' : 'none' }}>
              <VaultScreen vaultAddress={selectedVault} />
            </div>
            <div style={{ display: tab === 'pay' ? 'block' : 'none' }}>
              <PayScreen vaultAddress={selectedVault} onActivity={triggerActivity} onStormResults={handleStormResults} />
            </div>
            <div style={{ display: tab === 'activity' ? 'block' : 'none' }}>
              <ActivityScreen vaultAddress={selectedVault} refreshTrigger={activityTrigger} stormResults={stormResults} />
            </div>
          </>
        )}

        {/* Not connected — prompt */}
        {!isConnected && !selectedVault && (
          <div className="rounded-2xl p-8 text-center" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <Shield className="size-10 mx-auto mb-3" style={{ color: 'var(--border-strong)' }} />
            <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Connect your wallet</p>
            <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>Connect to create or manage your vault, or open a vault link to view it read-only.</p>
          </div>
        )}

        {/* Connected but no vault selected (read-only URL) */}
        {!isConnected && selectedVault && (
          <>
            <div className="mb-5 grid grid-cols-3 gap-1 rounded-2xl p-1"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
              {TABS.map(({ id, label, Icon }) => (
                <button key={id} onClick={() => setTab(id)}
                  className="flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-semibold transition-all"
                  style={tab === id ? { background: '#fff', color: 'var(--ink)', boxShadow: '0 1px 4px rgba(18,45,69,0.10)' } : { color: 'var(--subtle)' }}>
                  <Icon className="size-3.5" />{label}
                </button>
              ))}
            </div>
            <div style={{ display: tab === 'vault' ? 'block' : 'none' }}>
              <VaultScreen vaultAddress={selectedVault} />
            </div>
            <div style={{ display: tab === 'activity' ? 'block' : 'none' }}>
              <ActivityScreen vaultAddress={selectedVault} refreshTrigger={activityTrigger} stormResults={stormResults} />
            </div>
          </>
        )}

      </div>
    </div>
  )
}
