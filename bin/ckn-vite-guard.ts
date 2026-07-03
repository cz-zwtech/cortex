#!/usr/bin/env tsx
/**
 * ckn-vite-guard — vite-side single-instance guard (#141), the :1420 mirror of the
 * server's :3001 guard (28b4c31 / #117).
 *
 * `cortex start` runs `concurrently "npm run server" "npm run dev"`. The server
 * guard makes a dogpiled server exit 0 cleanly, but vite (vite.config.ts
 * strictPort:true) HARD-EXITS 1 on a :1420 collision, and concurrently propagates
 * that non-zero child — so a second `cortex start` took the whole terminal down
 * with exit 1. This guard probes :1420 first: if the UI is already up it logs and
 * exits 0 (a dogpile NO-OPs — never a second UI on 1421), otherwise it hands off
 * to vite. strictPort stays true so a genuine single launch still fails loudly if
 * 1420 is held by something unexpected.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { portAlreadyOwned } from '../server/singleInstanceGuard.js'

const VITE_PORT = Number(process.env.CKN_UI_PORT ?? '1420')

const main = async () => {
  if (await portAlreadyOwned(VITE_PORT)) {
    console.log(
      `[ckn] :${VITE_PORT} already in use — cortex UI already running, skipping (single-instance guard).`,
    )
    return
  }
  // Hand off to the real vite, forwarding any extra args and inheriting stdio so
  // the dev server output shows normally. Resolve the binary repo-relative so it
  // works regardless of PATH.
  const here = dirname(fileURLToPath(import.meta.url))
  const viteBin = join(here, '..', 'node_modules', '.bin', 'vite')
  const child = spawn(viteBin, process.argv.slice(2), { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
  child.on('error', (e) => {
    console.error('[ckn-vite-guard] failed to start vite:', (e as Error)?.message ?? e)
    process.exit(1)
  })
}

main().catch((e) => {
  console.error('[ckn-vite-guard] fatal:', e?.message ?? e)
  process.exit(1)
})
