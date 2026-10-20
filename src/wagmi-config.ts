import { createConfig, http, fallback } from 'wagmi'
import { getDefaultConfig } from 'connectkit'
import { injected, walletConnect } from 'wagmi/connectors'
import { CHAIN, CHAIN_ID, RPC_PROXY_URLS, RPC_FALLBACKS } from './onchain-config'

// Build transport: all 4 proxy paths first (same-origin, ad-block safe, load spread),
// then direct official URLs as last resort.
// batch:true enables JSON-RPC batching to cut request count.
// rank:false + retryCount:2 — treat 429 as a reason to move to the next transport.
const transport = fallback(
  [
    ...RPC_PROXY_URLS.map(url => http(url, { batch: true })),
    ...RPC_FALLBACKS.map(url => http(url, { batch: true })),
  ],
  { rank: false, retryCount: 2 },
)

// Explicit connectors: injected() always; walletConnect only when a project ID is set.
// This avoids the "Aave Account" and other auto-injected connectors that can throw
// connection-timeout errors when ConnectKit uses getDefaultConfig without restrictions.
const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? ''
const connectors = wcProjectId
  ? [injected(), walletConnect({ projectId: wcProjectId })]
  : [injected()]

export const wagmiConfig = createConfig(
  getDefaultConfig({
    chains: [CHAIN],
    transports: {
      [CHAIN_ID]: transport,
    },
    connectors,
    // Multicall batching: reads coalesce into a single eth_call where possible.
    batch: { multicall: true },
    // Poll only every 4 s to keep RPC request volume low.
    // Background polling still kicks in while a tx is pending via waitForTransactionReceipt.
    pollingInterval: 4_000,
    walletConnectProjectId: wcProjectId,
    appName: 'Once',
    appDescription: 'USDC Payout Vault — every intent paid exactly once.',
    appUrl: typeof window !== 'undefined' ? window.location.origin : 'https://once.app',
  }),
)
