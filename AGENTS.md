# Once — Project Memory

## Deployed Contracts

| Contract | Network | Address | Explorer |
|---|---|---|---|
| OncePayoutVault | Arc Testnet | `0x781cb1b21aca681e8320ae8e6960016e68e93920` | https://explorer.testnet.arc.io/address/0x781cb1b21aca681e8320ae8e6960016e68e93920 |

## USDC on Arc Testnet
- Address: `0x3600000000000000000000000000000000000000`
- Decimals: 6
- Same address on mainnet and testnet (fixed predeploy)

## Chain Config File
`src/onchain-config.ts` — single source of truth for chain ID, USDC address, vault address, and explorer base URL. Change `NETWORK` here to switch to mainnet.

## Test results
30/30 Foundry tests passing — see `contracts/test/OncePayoutVault.t.sol`
