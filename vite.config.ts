import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'

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
      '/rpc/mainnet': {
        target: 'https://rpc.mainnet.arc.io',
        changeOrigin: true,
        rewrite: () => '/',
      },
      '/rpc/testnet': {
        target: 'https://rpc.testnet.arc.io',
        changeOrigin: true,
        rewrite: () => '/',
      },
      '/explorer-api': {
        target: 'https://explorer.arc.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/explorer-api/, '/api'),
      },
      '/explorer-api-testnet': {
        target: 'https://explorer.testnet.arc.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/explorer-api-testnet/, '/api'),
      },
    },
  },
})
