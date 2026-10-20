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
// Official Arc RPC endpoints — used in wagmi transport (wagmi-config.ts).
export const RPC_URL =
  NETWORK === 'mainnet'
    ? 'https://rpc.mainnet.arc.io'
    : 'https://rpc.testnet.arc.io'

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
