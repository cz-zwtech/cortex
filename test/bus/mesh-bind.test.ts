#!/usr/bin/env tsx
/**
 * FR-7 I4 — opt-in published mesh-accept bind (CKN_MESH_BIND). ⚠ security: this is
 * the ONLY part of Cortex that can listen off-loopback on a driver node, so the
 * invariants here are load-bearing and adversarial:
 *
 *   - default OFF: no CKN_MESH_BIND ⇒ no listener.
 *   - serves ONLY the /api/mesh/ws upgrade. NO app routes (a bare http server with no
 *     express app ⇒ every HTTP request is 404 — graph/bus/UI can NEVER leak on this
 *     port), and NO PTY /ws (that stays on the loopback listener).
 *   - slice #4 HARD CUTOVER: the upgrade is fail-closed on NO TOKEN (a keyless node
 *     cannot run the handshake, so refuse outright) but otherwise UNPRIVILEGED — the
 *     token is never sent as a bearer. A socket that opens but does not complete the
 *     in-band mutual handshake never promotes to a TRUSTED (peerNode'd) peer; one
 *     that does becomes an authed Link.
 *
 * Real ephemeral listener (startMeshBind returns the bound port) + real client
 * sockets, so the genuine upgrade/handshake path runs end to end.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { WebSocket } from 'ws'
import { dialerHandshake } from './_dialer-handshake.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mesh-bind-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_MESH_GOSSIP_MS = '600000'
process.env.CKN_MESH_TOKEN = 'fleet-secret'
process.env.CKN_MESH_PEERS = ''

const { meshBindConfig, startMeshBind, stopMeshBind } = await import('../../server/bus/meshBind.js')
const { stopWsMesh, wsPeerCount, wsLinks } = await import('../../server/bus/meshWs.js')

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await wait(10)
  }
}
function httpStatus(port: number, p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
  })
}
/** Try a WS upgrade; resolve 'open' | 'rejected' (never throws out). */
function tryWs(url: string, headers?: Record<string, string>): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined)
    ws.on('open', () => {
      ws.close()
      resolve('open')
    })
    ws.on('error', () => resolve('rejected'))
    ws.on('unexpected-response', () => resolve('rejected'))
  })
}

/** Open a WS and hand back the live socket (caller drives the handshake / closes). */
function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => resolve(ws))
    ws.on('error', (e) => reject(e))
    ws.on('unexpected-response', () => reject(new Error('unexpected-response')))
  })
}

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

async function main() {
  // ── config parse ──────────────────────────────────────────────────────────
  assert.equal(meshBindConfig(''), null, 'empty ⇒ OFF')
  assert.equal(meshBindConfig(undefined), null, 'unset ⇒ OFF')
  assert.equal(meshBindConfig('0'), null, 'port 0 ⇒ OFF (no ephemeral via env)')
  assert.equal(meshBindConfig('abc'), null, 'non-numeric ⇒ OFF')
  assert.deepEqual(meshBindConfig('9444'), { host: '0.0.0.0', port: 9444 }, 'bare port ⇒ all-ifaces')
  assert.deepEqual(meshBindConfig(':9444'), { host: '0.0.0.0', port: 9444 }, ':port ⇒ all-ifaces')
  assert.deepEqual(meshBindConfig('127.0.0.1:9444'), { host: '127.0.0.1', port: 9444 }, 'host:port')
  ok('meshBindConfig parses host:port / :port / port and defaults OFF')

  // ── default OFF: startMeshBind(null) starts nothing ──────────────────────────
  assert.equal(await startMeshBind(null), null, 'no config ⇒ no listener')
  ok('startMeshBind is OFF without a config')

  // ── start on an ephemeral loopback port (returns the bound port) ─────────────
  const port = await startMeshBind({ host: '127.0.0.1', port: 0 })
  assert.ok(typeof port === 'number' && port > 0, 'startMeshBind returns the bound port')
  ok(`published mesh-bind listening on 127.0.0.1:${port}`)

  // ── app routes do NOT leak on the published port (bare http ⇒ 404) ───────────
  assert.equal(await httpStatus(port!, '/'), 404, 'GET / ⇒ 404 (no UI on the mesh port)')
  assert.equal(await httpStatus(port!, '/api/graph/stats'), 404, 'GET /api/graph/stats ⇒ 404 (no app routes)')
  ok('no app/UI routes are served on the published mesh port')

  const wsBase = `ws://127.0.0.1:${port}/api/mesh/ws`

  // ── fail-closed: with NO token configured the upgrade is rejected outright ────
  // (a keyless node can't run the handshake, so there's nothing to authenticate).
  delete process.env.CKN_MESH_TOKEN
  assert.equal(await tryWs(wsBase), 'rejected', 'no token configured ⇒ upgrade rejected (fail-closed)')
  process.env.CKN_MESH_TOKEN = 'fleet-secret'
  await wait(30)
  assert.equal(wsPeerCount(), 0, 'a rejected upgrade never becomes a Link')
  ok('the published mesh upgrade is fail-closed: no token ⇒ no upgrade')

  // ── PTY /ws is NOT exposed here (only /api/mesh/ws is served) ──────────────────
  assert.equal(await tryWs(`ws://127.0.0.1:${port}/ws`), 'rejected', 'PTY /ws path is not served on the mesh port')
  await wait(50)
  assert.equal(wsPeerCount(), 0, 'a /ws attempt on the mesh port never becomes a Link')
  ok('PTY /ws is not exposed on the published mesh port')

  // ── unprivileged upgrade: a socket opens WITHOUT a bearer, but is NOT a trusted
  // peer until the in-band handshake completes (the token never rode a header). ──
  const unauthed = await openWs(wsBase)
  await wait(50)
  assert.equal(wsPeerCount(), 1, 'the unprivileged upgrade opens a socket (a Link exists)')
  assert.ok(
    wsLinks().every((l) => l.peerNode === ''),
    'an un-handshaken socket is NOT a trusted (peerNode) peer',
  )
  unauthed.close()
  await until(() => wsPeerCount() === 0)
  ok('the published upgrade is unprivileged — trust requires the in-band handshake, not a header')

  // ── happy path: a peer that completes the in-band handshake becomes an authed
  // Link. The server reaching onAuthed (and sending its hello) IS the authed proof. ─
  const peer = await openWs(wsBase)
  const gotHello = new Promise<void>((resolve) => {
    peer.on('message', (d) => {
      try {
        if (JSON.parse(String(d))?.t === 'hello') resolve()
      } catch {
        /* ignore non-JSON / handshake frames */
      }
    })
  })
  await dialerHandshake(peer, 'fleet-secret')
  await gotHello // server side reached onAuthed ⇒ genuinely authed, not merely open
  await until(() => wsPeerCount() === 1)
  ok('a peer that completes the in-band handshake becomes an authed Link on the published port')
  peer.close()
  await until(() => wsPeerCount() === 0)

  // ── teardown ──────────────────────────────────────────────────────────────
  stopWsMesh()
  stopMeshBind()
  assert.equal(await startMeshBind({ host: '127.0.0.1', port: 0 }) !== null, true, 'restartable after stop')
  stopMeshBind()

  console.log(`\n${passed} assertions passed.`)
}

main().then(
  () => {
    cleanup()
    process.exit(0)
  },
  (err) => {
    cleanup()
    console.error(err)
    process.exit(1)
  },
)
