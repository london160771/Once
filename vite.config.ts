import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'

// RPC proxy targets for dev server — mirrors vercel.json rewrites
// dRPC removed — returns 500/502 through the proxy
const rpcProxies: Record<string, string> = {
  '/rpc/mainnet':   'https://rpc.mainnet.arc.io',
  '/rpc/mainnet-2': 'https://rpc.blockdaemon.mainnet.arc.io',
  '/rpc/mainnet-3': 'https://rpc.quicknode.mainnet.arc.io',
  '/rpc/testnet':   'https://rpc.testnet.arc.io',
  '/rpc/testnet-2': 'https://rpc.blockdaemon.testnet.arc.io',
  '/rpc/testnet-3': 'https://rpc.quicknode.testnet.arc.io',
}

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    allowedHosts: true,
    proxy: {
      ...Object.fromEntries(
        Object.entries(rpcProxies).map(([prefix, target]) => [
          prefix,
          { target, changeOrigin: true, rewrite: () => '/' },
        ]),
      ),
      '/explorer-api': {
        target: 'https://explorer.arc.io',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/explorer-api/, '/api'),
      },
      '/explorer-api-testnet': {
        target: 'https://explorer.testnet.arc.io',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/explorer-api-testnet/, '/api'),
      },
    },
  },
})
