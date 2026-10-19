# Once — Project Memory

## Deployed Contracts

| Contract | Network | Address | Explorer |
|---|---|---|---|
| OncePayoutVault (v1, wrong owner — retired) | Arc Testnet | `0x781cb1b21aca681e8320ae8e6960016e68e93920` | https://explorer.testnet.arc.io/address/0x781cb1b21aca681e8320ae8e6960016e68e93920 |
| OncePayoutVault (v2, single vault — retired) | Arc Testnet | `0xbd4864d24de630acb4455448f2b84206968720c4` | https://explorer.testnet.arc.io/address/0xbd4864d24de630acb4455448f2b84206968720c4 |
| OncePayoutVaultFactory (active) | Arc Testnet | `0xb297e7c8c2ef32a9edd8841876b0df5a8cec67b7` | https://explorer.testnet.arc.io/address/0xb297e7c8c2ef32a9edd8841876b0df5a8cec67b7 |

## USDC on Arc Testnet
- Address: `0x3600000000000000000000000000000000000000`
- Decimals: 6
- Same address on mainnet and testnet (fixed predeploy)

## Chain Config File
`src/onchain-config.ts` — single source of truth for chain ID, USDC address, vault address, and explorer base URL. Change `NETWORK` here to switch to mainnet.

## Test results
30/30 Foundry tests passing — see `contracts/test/OncePayoutVault.t.sol`
