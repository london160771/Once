# Once — USDC Payout Vault

**Once** is an idempotent USDC payout vault. Every payout happens exactly once and never exceeds the approved budget, even if the same intent is submitted 1,000 times by 1,000 different callers.

---

## Deployed Contracts

| Contract | Network | Address | Explorer |
|---|---|---|---|
| OncePayoutVaultFactory | Arc Testnet | `0xb297e7c8c2ef32a9edd8841876b0df5a8cec67b7` | [View on ArcScan](https://explorer.testnet.arc.io/address/0xb297e7c8c2ef32a9edd8841876b0df5a8cec67b7) |

Each user deploys their own `OncePayoutVault` through the factory. No vault address is hardcoded — call `createVault()` or connect your wallet in the app.

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
| **Vault** | Connect wallet, deposit USDC, set budget, view balance / budget / totalPaid / remaining |
| **Pay** | Enter recipient and amount, auto-generate an `intentId`, send a payment. "Retry Storm" fires the same intent 5× and shows which succeeded and which were refused with their reason code |
| **Activity** | Live feed of `Paid` events from the last 5,000 blocks, each with an explorer link |

---

## Verifying contracts on the explorer

Both contracts are verified on Arc Testnet (Blockscout). Rerun these commands after any redeployment — they work on mainnet too by changing `--chain-id` and `--verifier-url`.

```bash
# Verify OncePayoutVaultFactory (no constructor args)
forge verify-contract <FACTORY_ADDRESS> \
  contracts/OncePayoutVaultFactory.sol:OncePayoutVaultFactory \
  --chain-id 5042002 \
  --verifier blockscout \
  --verifier-url https://explorer.testnet.arc.io/api/ \
  --watch

# Verify OncePayoutVault (pass the usdc + owner constructor args)
forge verify-contract <VAULT_ADDRESS> \
  contracts/OncePayoutVault.sol:OncePayoutVault \
  --chain-id 5042002 \
  --verifier blockscout \
  --verifier-url https://explorer.testnet.arc.io/api/ \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
      0x3600000000000000000000000000000000000000 \
      <OWNER_ADDRESS>) \
  --watch

# For Arc mainnet, change:
#   --chain-id 5042
#   --verifier-url https://explorer.arc.io/api/
```

---

## Chain configuration

All chain settings live in **`src/onchain-config.ts`**.

To switch to Arc mainnet:

```typescript
// src/onchain-config.ts
export const NETWORK = 'mainnet' as 'testnet' | 'mainnet'
```

Then redeploy the factory on Arc mainnet, update `FACTORY_ADDRESS`, verify both contracts using the commands above (with mainnet chain-id and verifier-url), and rebuild.

---

## Tests

30 Foundry tests cover every requirement:

```
forge test --match-path contracts/test/OncePayoutVault.t.sol -v
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

# Dev server
bun run dev

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
