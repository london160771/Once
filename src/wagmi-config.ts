import { createConfig, http } from 'wagmi'
import { getDefaultConfig } from 'connectkit'
import { CHAIN, CHAIN_ID } from './onchain-config'

export const wagmiConfig = createConfig(
  getDefaultConfig({
    chains: [CHAIN],
    transports: {
      [CHAIN_ID]: http(),
    },
    walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '',
    appName: 'Once',
    appDescription: 'USDC Payout Vault — every intent paid exactly once.',
    appUrl: typeof window !== 'undefined' ? window.location.origin : 'https://once.app',
  }),
)
