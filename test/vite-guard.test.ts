import assert from 'node:assert/strict'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// #141 — vite-side single-instance guard, the :1420 mirror of the server's :3001
// guard (#117). `cortex start` = concurrently server+vite; the server guard makes
// a dogpiled server exit 0, but vite (strictPort:true) HARD-EXITS 1 on a :1420
// collision and concurrently propagates that non-zero child, taking the terminal
// down. The guard must NO-OP a dogpile: detect the owned port, log, exit 0 —
// never launch a second UI.
const here = dirname(fileURLToPath(import.meta.url))
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx')
const guard = join(here, '..', 'bin', 'ckn-vite-guard.ts')

// Occupy an ephemeral port, then run the guard pointed at it.
const srv = net.createServer()
await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
const port = (srv.address() as net.AddressInfo).port

const r = spawnSync(tsx, [guard], {
  env: { ...process.env, CKN_UI_PORT: String(port) },
  encoding: 'utf8',
  timeout: 20000,
})
srv.close()

assert.equal(r.status, 0, `guard should exit 0 on an owned port, got ${r.status} (stderr: ${r.stderr})`)
assert.match(r.stdout ?? '', /already in use/, 'guard should log the skip message')

console.log('vite-guard: dogpile on an owned port no-ops (exit 0) OK')
process.exit(0)
