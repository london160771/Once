import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectKitProvider } from 'connectkit'
import { Toaster } from 'sonner'
import { wagmiConfig } from './wagmi-config'
import App from './App'
import './index.css'

const queryClient = new QueryClient()

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

createRoot(root).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider
          customTheme={{
            '--ck-font-family': "'DM Sans', sans-serif",
            '--ck-primary-button-background': '#122d45',
            '--ck-primary-button-hover-background': '#1061a6',
            '--ck-body-background': '#fffcf7',
            '--ck-body-color': '#122d45',
            '--ck-border-radius': '16px',
          }}
        >
          <App />
          <Toaster position="bottom-center" richColors />
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>
)
