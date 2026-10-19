import { useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { Shield, Send, Activity } from 'lucide-react'
import { VaultScreen } from './components/VaultScreen'
import { PayScreen, type AttemptResult } from './components/PayScreen'
import { ActivityScreen } from './components/ActivityScreen'
import { VAULT_ADDRESS, EXPLORER_BASE } from './onchain-config'
import { formatAddress } from './utils'

type Tab = 'vault' | 'pay' | 'activity'

const TABS: { id: Tab; label: string; Icon: typeof Shield }[] = [
  { id: 'vault', label: 'Vault', Icon: Shield },
  { id: 'pay', label: 'Pay', Icon: Send },
  { id: 'activity', label: 'Activity', Icon: Activity },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('vault')
  const [activityTrigger, setActivityTrigger] = useState(0)
  // Storm results are lifted here so Activity can show refused attempts
  const [stormResults, setStormResults] = useState<AttemptResult[]>([])

  const triggerActivity = () => setActivityTrigger(n => n + 1)

  const handleStormResults = (results: AttemptResult[]) => {
    setStormResults(results)
    triggerActivity()
  }

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      <div className="mx-auto max-w-md px-4 pb-24 pt-6">
        {/* Header */}
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1
              className="display text-2xl font-bold"
              style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}
            >
              Once
            </h1>
            <a
              href={`${EXPLORER_BASE}/address/${VAULT_ADDRESS}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mono text-xs"
              style={{ color: 'var(--muted)' }}
            >
              {formatAddress(VAULT_ADDRESS)} ↗
            </a>
          </div>
          <ConnectKitButton />
        </header>

        {/* Tagline */}
        <div
          className="mb-5 rounded-2xl px-4 py-3 text-xs"
          style={{ background: 'rgba(18,45,69,0.04)', border: '1px solid var(--border)' }}
        >
          <span className="font-semibold" style={{ color: 'var(--ink-2)' }}>Idempotent USDC payouts.</span>
          {' '}
          <span style={{ color: 'var(--muted)' }}>
            Every intent paid exactly once — no double-spends, no over-budget surprises, even under retries.
          </span>
        </div>

        {/* Tab bar */}
        <div
          className="mb-5 grid grid-cols-3 gap-1 rounded-2xl p-1"
          style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
        >
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className="flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-semibold transition-all"
              style={
                tab === id
                  ? { background: '#fff', color: 'var(--ink)', boxShadow: '0 1px 4px rgba(18,45,69,0.10)' }
                  : { color: 'var(--subtle)' }
              }
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Screens — keep all mounted so state persists across tab switches */}
        <div style={{ display: tab === 'vault' ? 'block' : 'none' }}>
          <VaultScreen />
        </div>
        <div style={{ display: tab === 'pay' ? 'block' : 'none' }}>
          <PayScreen onActivity={triggerActivity} onStormResults={handleStormResults} />
        </div>
        <div style={{ display: tab === 'activity' ? 'block' : 'none' }}>
          <ActivityScreen refreshTrigger={activityTrigger} stormResults={stormResults} />
        </div>
      </div>
    </div>
  )
}
