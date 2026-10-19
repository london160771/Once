/**
 * Once Payout Vault — chain configuration.
 * Change ACTIVE_CHAIN to switch between testnet and mainnet.
 * Never import chain IDs, RPC URLs, or USDC addresses from memory — read them here.
 */

import { arcTestnet, arc } from 'viem/chains'

// ─── Network switch ────────────────────────────────────────────────────────────
//  'testnet'  →  Arc Testnet  (chain ID 5042002)
//  'mainnet'  →  Arc Mainnet  (chain ID 5042)   — requires explicit user approval
export const NETWORK = 'testnet' as 'testnet' | 'mainnet'

// ─── Chain objects ─────────────────────────────────────────────────────────────
export const CHAIN = NETWORK === 'mainnet' ? arc : arcTestnet
export const CHAIN_ID = CHAIN.id as number  // 5042002 on testnet

// ─── USDC (ERC-20, 6 decimals) ─────────────────────────────────────────────────
// On Arc, USDC is the native gas token AND an ERC-20 at this fixed predeploy address.
// The address is the same on mainnet and testnet.
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const
export const USDC_DECIMALS = 6

// ─── Contract ──────────────────────────────────────────────────────────────────
export const VAULT_ADDRESS = '0x781cb1b21aca681e8320ae8e6960016e68e93920' as `0x${string}`

// ─── Explorer ──────────────────────────────────────────────────────────────────
export const EXPLORER_BASE =
  NETWORK === 'mainnet'
    ? 'https://explorer.arc.io'
    : 'https://explorer.testnet.arc.io'

export const buildTxUrl = (hash: string) => `${EXPLORER_BASE}/tx/${hash}`
export const buildAddressUrl = (addr: string) => `${EXPLORER_BASE}/address/${addr}`
