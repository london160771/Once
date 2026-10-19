export const FACTORY_ABI = [
  {
    "type": "constructor",
    "inputs": [{ "name": "_usdc", "type": "address", "internalType": "address" }],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "createVault",
    "inputs": [],
    "outputs": [{ "name": "vault", "type": "address", "internalType": "address" }],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getVaults",
    "inputs": [{ "name": "owner", "type": "address", "internalType": "address" }],
    "outputs": [{ "name": "", "type": "address[]", "internalType": "address[]" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "usdc",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address", "internalType": "address" }],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "VaultCreated",
    "inputs": [
      { "name": "owner", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "vault", "type": "address", "indexed": true, "internalType": "address" }
    ],
    "anonymous": false
  }
] as const
