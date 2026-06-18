#!/usr/bin/env tsx
/**
 * single-instance guard — the bus-wedge hardening. A second server launch on an
 * already-owned :3001 must exit cleanly (never dogpile → wedge the graph/bus). Two
 * units, both testable WITHOUT booting the real server (no hookRegistrar hijack):
 *   - listenErrorAction: pure decision for a server.listen 'error' (EADDRINUSE →
 *     clean exit; anything else → rethrow the real failure).
 *   - portAlreadyOwned: the pre-listen probe (reuses isServerUp), verified against a
 *     bare net listener on a temp port — occupied → true, freed → false.
 */
import assert from 'node:assert/strict'
import net from 'node:net'

const { listenErrorAction, portAlreadyOwned } = await import('../server/singleInstanceGuard.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// ── listenErrorAction (pure): a port clash exits clean; a real failure rethrows ──
{
  assert.equal(listenErrorAction('EADDRINUSE'), 'exit', 'EADDRINUSE → clean exit')
  assert.equal(listenErrorAction('EACCES'), 'rethrow', 'EACCES → rethrow (real failure)')
  assert.equal(listenErrorAction(undefined), 'rethrow', 'no code → rethrow')
  assert.equal(listenErrorAction('EPIPE'), 'rethrow', 'unrelated code → rethrow')
  ok('listenErrorAction: only EADDRINUSE triggers a clean exit')
}

// ── portAlreadyOwned: detects a live listener, clears once it closes ──
{
  const srv = net.createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as net.AddressInfo).port
  assert.equal(await portAlreadyOwned(port), true, 'occupied port detected as owned')
  await new Promise<void>((r) => srv.close(() => r()))
  assert.equal(await portAlreadyOwned(port), false, 'freed port detected as available')
  ok('portAlreadyOwned: true when owned, false when free (the port-already-owned path)')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
