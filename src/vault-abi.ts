export const VAULT_ABI = [
  {
    "type": "constructor",
    "inputs": [
      { "name": "_usdc", "type": "address", "internalType": "address" },
      { "name": "_owner", "type": "address", "internalType": "address" }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "addPayer",
    "inputs": [{ "name": "payer", "type": "address", "internalType": "address" }],
    "outputs": [], "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "allowedPayers",
    "inputs": [{ "name": "", "type": "address", "internalType": "address" }],
    "outputs": [{ "name": "", "type": "bool", "internalType": "bool" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "approvedBudget",
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint256", "internalType": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "fund",
    "inputs": [{ "name": "amount", "type": "uint256", "internalType": "uint256" }],
    "outputs": [], "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "owner",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address", "internalType": "address" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "paidIntents",
    "inputs": [{ "name": "", "type": "bytes32", "internalType": "bytes32" }],
    "outputs": [{ "name": "", "type": "bool", "internalType": "bool" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "pay",
    "inputs": [
      { "name": "intentId", "type": "bytes32", "internalType": "bytes32" },
      { "name": "to", "type": "address", "internalType": "address" },
      { "name": "amount", "type": "uint256", "internalType": "uint256" },
      { "name": "expiresAt", "type": "uint64", "internalType": "uint64" }
    ],
    "outputs": [], "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "removePayer",
    "inputs": [{ "name": "payer", "type": "address", "internalType": "address" }],
    "outputs": [], "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "setBudget",
    "inputs": [{ "name": "newBudget", "type": "uint256", "internalType": "uint256" }],
    "outputs": [], "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "totalPaid",
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint256", "internalType": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "transferOwnership",
    "inputs": [{ "name": "newOwner", "type": "address", "internalType": "address" }],
    "outputs": [], "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "usdc",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address", "internalType": "contract IERC20" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "withdrawUnspent",
    "inputs": [], "outputs": [], "stateMutability": "nonpayable"
  },
  {
    "type": "event", "name": "BudgetSet",
    "inputs": [
      { "name": "oldBudget", "type": "uint256", "indexed": false },
      { "name": "newBudget", "type": "uint256", "indexed": false }
    ],
    "anonymous": false
  },
  {
    "type": "event", "name": "Funded",
    "inputs": [
      { "name": "from", "type": "address", "indexed": true },
      { "name": "amount", "type": "uint256", "indexed": false }
    ],
    "anonymous": false
  },
  {
    "type": "event", "name": "Paid",
    "inputs": [
      { "name": "intentId", "type": "bytes32", "indexed": true },
      { "name": "to", "type": "address", "indexed": true },
      { "name": "amount", "type": "uint256", "indexed": false }
    ],
    "anonymous": false
  },
  {
    "type": "event", "name": "PayerAdded",
    "inputs": [{ "name": "payer", "type": "address", "indexed": true }],
    "anonymous": false
  },
  {
    "type": "event", "name": "PayerRemoved",
    "inputs": [{ "name": "payer", "type": "address", "indexed": true }],
    "anonymous": false
  },
  {
    "type": "event", "name": "Withdrawn",
    "inputs": [
      { "name": "to", "type": "address", "indexed": true },
      { "name": "amount", "type": "uint256", "indexed": false }
    ],
    "anonymous": false
  },
  { "type": "error", "name": "DUPLICATE_INTENT", "inputs": [] },
  { "type": "error", "name": "INTENT_EXPIRED", "inputs": [] },
  { "type": "error", "name": "NOT_PAYER", "inputs": [] },
  { "type": "error", "name": "OVER_BUDGET", "inputs": [] },
  {
    "type": "error", "name": "OwnableInvalidOwner",
    "inputs": [{ "name": "owner", "type": "address", "internalType": "address" }]
  },
  {
    "type": "error", "name": "OwnableUnauthorizedAccount",
    "inputs": [{ "name": "account", "type": "address", "internalType": "address" }]
  },
  {
    "type": "error", "name": "SafeERC20FailedOperation",
    "inputs": [{ "name": "token", "type": "address", "internalType": "address" }]
  }
] as const
