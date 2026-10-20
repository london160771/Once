import { useAccount } from 'wagmi'

/**
 * Returns true when the connected wallet is OKX Wallet.
 * Detects via connector name/id and window flags.
 */
export function useIsOkxWallet(): boolean {
  const { connector } = useAccount()

  // Connector-level check (works for wagmi/ConnectKit connectors)
  if (connector) {
    const name = (connector.name ?? '').toLowerCase()
    const id = (connector.id ?? '').toLowerCase()
    if (name.includes('okx') || id.includes('okx')) return true
  }

  // window flag checks (set by the OKX Wallet browser extension)
  if (typeof window !== 'undefined') {
    if ((window as unknown as Record<string, unknown>).okxwallet) return true
    const eth = (window as unknown as { ethereum?: { isOkxWallet?: boolean } }).ethereum
    if (eth?.isOkxWallet) return true
  }

  return false
}
