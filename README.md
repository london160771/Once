# Once — USDC Payout Vault

**Once** is an idempotent USDC payout vault. Every payout happens exactly once and never exceeds the approved budget, even if the same intent is submitted 1,000 times by 1,000 different callers.

---

## Deployed Contracts

| Contract | Network | Address | Deploy Tx | Explorer |
|---|---|---|---|---|
| OncePayoutVaultFactory | Arc Mainnet | `0x006c1Ef4a55221173caac47C7ad9fed25A35562D` | [`0x07995c3d…`](https://explorer.arc.io/tx/0x07995c3db8729ab945f9b3f2bdffc36b0f3c705737b86ec7cd7e6d1193c25e6a) | [View](https://explorer.arc.io/address/0x006c1Ef4a55221173caac47C7ad9fed25A35562D) |
| OncePayoutVaultFactory | Arc Testnet | `0x9Bc81f3c411CB2EbFA1308e25f8c31A58772819C` | — | [View](https://explorer.testnet.arc.io/address/0x9Bc81f3c411CB2EbFA1308e25f8c31A58772819C) |

Each user deploys their own `OncePayoutVault` through the factory. No vault address is hardcoded — call `createVault()` or connect your wallet in the app.

---

## Wallet compatibility

| Wallet | Status |
|---|---|
| **Rabby** | Fully supported — recommended |
| **MetaMask** | Fully supported |
| **OKX Wallet** | Partial — see note below |

**OKX Wallet and Arc USDC:** OKX Wallet misreads the Arc USDC token (`0x3600000000000000000000000000000000000000`, 6 decimals). It displays approval amounts as **0 USDC** in the wallet confirmation dialog, even when the app sends the exact amount (e.g. `approve(vault, 1000000)` for 1.00 USDC). This is an OKX display issue — the on-chain approval is correct and the app shows the real amount.

OKX Wallet may also fail to estimate gas for `createVault()` on Arc. If this happens the app will show an error toast and will not open the wallet — no transaction is sent. Switch to Rabby or MetaMask to create a vault, then reconnect with OKX Wallet for day-to-day use.

---

## Built with Arc Studio

The contracts, tests, and frontend were built with [Arc Studio](https://studio.arc.io/app/473c2c20-a2e7-42c3-931d-0e6c1e923d01) — Circle's onchain app builder.

The Arc Mainnet factory was deployed by the owner using Remix + Rabby with the same compiler settings as the contracts: Solidity 0.8.28, optimizer 200 runs, `paris` EVM target.

---

## How it works

### The idempotency guarantee

Each payout is identified by a `bytes32 intentId`. Before any USDC moves, the contract:

1. Verifies the caller is the owner or an allowed payer (`NOT_PAYER`).
2. Checks the intent has not expired (`INTENT_EXPIRED`).
3. Checks the intent has never been paid (`DUPLICATE_INTENT`).
4. Checks the payment doesn't exceed the remaining budget (`OVER_BUDGET`).
5. **Marks the intent as paid** (checks-effects-interactions — before transfer).
6. Increments `totalPaid`.
7. Transfers USDC to the recipient.

Step 5 happens before the transfer. A re-entrant call or a concurrent retry both see `paidIntents[intentId] == true` and revert with `DUPLICATE_INTENT`.

### The budget invariant

`totalPaid <= approvedBudget` holds at all times. `setBudget` refuses to lower the budget below `totalPaid`, and every `pay()` call checks before spending.

### Error reason codes

| Code | Meaning |
|---|---|
| `NOT_PAYER` | Caller is not the owner or an allowed payer |
| `INTENT_EXPIRED` | `block.timestamp > expiresAt` |
| `DUPLICATE_INTENT` | This `intentId` was already paid |
| `OVER_BUDGET` | `totalPaid + amount > approvedBudget` |

---

## Contract interface

```solidity
// Deposit USDC into the vault (caller must approve first)
function fund(uint256 amount) external;

// Set the approved payout budget (owner only)
function setBudget(uint256 newBudget) external;

// Add / remove a payer address (owner only)
function addPayer(address payer) external;
function removePayer(address payer) external;

// Pay a recipient — idempotent on intentId
function pay(bytes32 intentId, address to, uint256 amount, uint64 expiresAt) external;

// Withdraw vault balance minus uncommitted budget (owner only)
function withdrawUnspent() external;
```

---

## Frontend

Three screens, accessible via tab bar:

| Screen | What it does |
|---|---|
| **Vault** | Deposit USDC, set budget, view balance / budget / totalPaid / remaining |
| **Pay** | Enter recipient and amount, auto-generate an `intentId`, send a payment. "Retry Storm" fires the same intent 5× and shows which succeeded and which were refused with their reason code |
| **Activity** | Onchain history from the Arc explorer API — pay() calls (PAID and REFUSED), plus neutral rows for deposit/budget/withdraw transactions |

---

## Network configuration

The active network is controlled by the `VITE_NETWORK` environment variable.

| Value | Network | Chain ID | Factory |
|---|---|---|---|
| `mainnet` (default) | Arc Mainnet | 5042 | `0x006c1Ef4a55221173caac47C7ad9fed25A35562D` |
| `testnet` | Arc Testnet | 5042002 | `0x9Bc81f3c411CB2EbFA1308e25f8c31A58772819C` |

Set in `.env`:

```
VITE_NETWORK=testnet
```

A **MAINNET** or **TESTNET** badge is shown in the app header so the active network is always visible.

---

## Verifying contracts on the explorer

Both contracts are verified on the Arc explorer (Blockscout). Rerun these commands after any redeployment.

```bash
# Verify OncePayoutVaultFactory
forge verify-contract <FACTORY_ADDRESS> \
  contracts/OncePayoutVaultFactory.sol:OncePayoutVaultFactory \
  --chain-id <5042 or 5042002> \
  --verifier blockscout \
  --verifier-url <https://explorer.arc.io/api/ or https://explorer.testnet.arc.io/api/> \
  --constructor-args $(cast abi-encode "constructor(address)" \
      0x3600000000000000000000000000000000000000) \
  --watch

# Verify OncePayoutVault
forge verify-contract <VAULT_ADDRESS> \
  contracts/OncePayoutVault.sol:OncePayoutVault \
  --chain-id <5042 or 5042002> \
  --verifier blockscout \
  --verifier-url <https://explorer.arc.io/api/ or https://explorer.testnet.arc.io/api/> \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
      0x3600000000000000000000000000000000000000 \
      <OWNER_ADDRESS>) \
  --watch
```

---

## Tests

42 Foundry tests (30 vault + 12 factory) cover every requirement:

```bash
forge test -v
```

Tests include:
- Single intent paid once
- Same `intentId` a second time → `DUPLICATE_INTENT`
- 5 calls, same `intentId` → exactly 1 succeeds, 4 revert
- Over-budget → `OVER_BUDGET`
- Expired → `INTENT_EXPIRED`
- Non-payer → `NOT_PAYER`
- `withdrawUnspent` returns only uncommitted funds
- Fuzz invariant: `totalPaid <= approvedBudget` across 256 random sequences
- Seed scenario: budget 1.00, pay 0.40, 4 duplicates refused, 0.70 refused, final `totalPaid` == 0.40

---

## Development

```bash
# Install
bun install

# Dev server (mainnet by default)
bun run dev

# Dev server on testnet
VITE_NETWORK=testnet bun run dev

# Type check
bunx tsc --noEmit

# Contract tests
forge test
```

---

## Security notes

- Checks-effects-interactions is strictly enforced in `pay()`.
- `SafeERC20` is used for all USDC transfers.
- `withdrawUnspent()` uses `balanceOf` (not a stored counter) so unexpected deposits don't inflate the withdrawable amount beyond reality.
- `max` preset review returned clean (Critical + High + Medium + Low).

> `max` review is best-effort and is NOT a substitute for a paid third-party audit before production use.
