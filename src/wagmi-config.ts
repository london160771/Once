import { createConfig, http, fallback } from 'wagmi'
import { getDefaultConfig } from 'connectkit'
import { CHAIN, CHAIN_ID, RPC_URL_PROXY, RPC_FALLBACKS } from './onchain-config'

// Build transports: proxy first (same-origin, ad-block safe), then all official RPCs.
const transport = fallback([
  http(RPC_URL_PROXY),
  ...RPC_FALLBACKS.map(url => http(url)),
])

export const wagmiConfig = createConfig(
  getDefaultConfig({
    chains: [CHAIN],
    transports: {
      [CHAIN_ID]: transport,
    },
    walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '',
    appName: 'Once',
    appDescription: 'USDC Payout Vault — every intent paid exactly once.',
    appUrl: typeof window !== 'undefined' ? window.location.origin : 'https://once.app',
  }),
)
