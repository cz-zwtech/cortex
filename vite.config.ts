import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    // Worker-mode deployments expose the UI on the LAN so a developer's
    // main machine can reach it over a VLAN. Set CKN_BIND=0.0.0.0 in
    // env to bind all interfaces; default 127.0.0.1 keeps the dev
    // workstation case fully local. Same env var as the Express server —
    // both move together.
    host: process.env.CKN_BIND ?? '127.0.0.1',
    watch: {
      // WSL2 + Windows filesystem (/mnt/<drive>/) requires polling —
      // inotify doesn't fire for cross-OS file changes
      usePolling: true,
      interval: 300,
    },
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
})
