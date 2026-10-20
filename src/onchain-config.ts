/**
 * Once Payout Vault — chain configuration.
 * Network is read from VITE_NETWORK env var ('mainnet' | 'testnet'), defaulting to 'mainnet'.
 * Never hardcode chain IDs, RPC URLs, factory addresses, or USDC addresses in source.
 */

import { arcTestnet, arc } from 'viem/chains'

// ─── Network switch ────────────────────────────────────────────────────────────
// Set VITE_NETWORK=testnet in .env to switch to testnet.
// Default is mainnet.
export const NETWORK: 'testnet' | 'mainnet' =
  (import.meta.env.VITE_NETWORK === 'testnet' ? 'testnet' : 'mainnet') as 'testnet' | 'mainnet'

// ─── Chain objects ─────────────────────────────────────────────────────────────
export const CHAIN = NETWORK === 'mainnet' ? arc : arcTestnet
export const CHAIN_ID = CHAIN.id as number  // 5042 on mainnet, 5042002 on testnet

// ─── RPC endpoints ─────────────────────────────────────────────────────────────
// In the browser: use a same-origin proxy so ad-blockers (Brave Shields etc.)
// don't block requests to rpc.mainnet.arc.io / rpc.testnet.arc.io.
// In Node / SSR contexts (no window): fall back to the official RPC directly.
export const RPC_URL_OFFICIAL =
  NETWORK === 'mainnet'
    ? 'https://rpc.mainnet.arc.io'
    : 'https://rpc.testnet.arc.io'

// Same-origin proxy paths — Vercel rewrites in production, vite.config.ts proxy in dev.
// Each provider has its own path so load is spread across all four RPCs.
const _origin = typeof window !== 'undefined' ? window.location.origin : ''
const _pfx = NETWORK === 'mainnet' ? 'mainnet' : 'testnet'

export const RPC_PROXY_URLS: string[] = _origin
  ? [
      `${_origin}/rpc/${_pfx}`,
      `${_origin}/rpc/${_pfx}-2`,
      `${_origin}/rpc/${_pfx}-3`,
      `${_origin}/rpc/${_pfx}-4`,
    ]
  : []

// Primary proxy URL (first provider). Falls back to official when no window (SSR/tests).
export const RPC_URL_PROXY = RPC_PROXY_URLS[0] ?? RPC_URL_OFFICIAL

// Alias: primary RPC (kept for backwards compat).
export const RPC_URL = RPC_URL_PROXY

// Direct official URLs — last-resort fallbacks only (may be blocked by ad-blockers).
export const RPC_FALLBACKS: string[] =
  NETWORK === 'mainnet'
    ? [
        'https://rpc.mainnet.arc.io',
        'https://rpc.blockdaemon.mainnet.arc.io',
        'https://rpc.drpc.mainnet.arc.io',
        'https://rpc.quicknode.mainnet.arc.io',
      ]
    : [
        'https://rpc.testnet.arc.io',
        'https://rpc.blockdaemon.testnet.arc.io',
        'https://rpc.drpc.testnet.arc.io',
        'https://rpc.quicknode.testnet.arc.io',
      ]

// ─── USDC (ERC-20, 6 decimals) ─────────────────────────────────────────────────
// On Arc, USDC is the native gas token AND an ERC-20 at this fixed predeploy address.
// The address is the same on mainnet and testnet.
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const
export const USDC_DECIMALS = 6

// ─── Factory ───────────────────────────────────────────────────────────────────
// Per-network factory addresses. No vault address is hardcoded — vaults are
// created per user via createVault().
export const FACTORY_ADDRESS: `0x${string}` =
  NETWORK === 'mainnet'
    ? '0x006c1Ef4a55221173caac47C7ad9fed25A35562D'
    : '0x9Bc81f3c411CB2EbFA1308e25f8c31A58772819C'

// ─── Gas floor ─────────────────────────────────────────────────────────────────
// Arc protocol enforces a minimum base fee. Used as a floor in getFeeParams (utils.ts).
export const MIN_BASE_FEE_GWEI = 20n  // bigint gwei — same on both networks

// ─── Explorer ──────────────────────────────────────────────────────────────────
export const EXPLORER_BASE =
  NETWORK === 'mainnet'
    ? 'https://explorer.arc.io'
    : 'https://explorer.testnet.arc.io'

export const buildTxUrl = (hash: string) => `${EXPLORER_BASE}/tx/${hash}`
export const buildAddressUrl = (addr: string) => `${EXPLORER_BASE}/address/${addr}`

// ─── Explorer API base (ad-block safe) ────────────────────────────────────────
// In production (Vercel) and local dev (Vite proxy), use same-origin paths.
// /explorer-api  → https://explorer.arc.io/api     (mainnet)
// /explorer-api-testnet → https://explorer.testnet.arc.io/api  (testnet)
// Falls back to direct URL in non-browser environments.
export const EXPLORER_API_BASE =
  typeof window !== 'undefined'
    ? `${window.location.origin}/${NETWORK === 'mainnet' ? 'explorer-api' : 'explorer-api-testnet'}`
    : `${EXPLORER_BASE}/api`
