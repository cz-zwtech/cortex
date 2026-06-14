#!/usr/bin/env tsx
/**
 * GET /api/graph/resume-state wiring (#89): mounts the real graphRouter over a temp DB and
 * proves the endpoint composes the tested pure pieces against ground truth —
 *   - no open claim → ambiguous
 *   - mode=working → resumable
 *   - waiting-on:bus with NO reply landed → held; once a reply lands → resumable
 * (The decision logic itself is unit-tested in test/resume-state.test.ts.)
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import express from 'express'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-resume-state-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')

const { graphRouter } = await import('../../server/routes/graph.js')
const { claimThread, setClaimMode } = await import('../../server/graph/threads.js')
const { run } = await import('../../server/graph/db.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const app = express()
app.use(express.json())
app.use('/api/graph', graphRouter)
const server = http.createServer(app)
const cleanup = () => {
  try {
    server.close()
  } catch {
    /* noop */
  }
  fs.rmSync(dir, { recursive: true, force: true })
}
const base: string = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`)
  })
})
const verdict = async (session: string): Promise<string> => {
  const r = await fetch(`${base}/api/graph/resume-state?session=${encodeURIComponent(session)}`)
  return ((await r.json()) as { verdict: string }).verdict
}

try {
  const S = 's_resume'
  const T = 't_resume'
  assert.equal(await verdict(S), 'ambiguous')
  ok('no open claim → ambiguous (safe)')

  claimThread(T, S, 1000) // mode defaults to 'working'
  assert.equal(await verdict(S), 'resumable')
  ok('mode=working → resumable')

  setClaimMode(T, S, 'waiting-on:bus=m_go')
  assert.equal(await verdict(S), 'held')
  ok('waiting-on:bus with no reply landed → held')

  // a reply to m_go lands → predicate satisfied → resumable
  run(
    `INSERT INTO bus_messages (id, from_session, to_addr, kind, ref, body, created_at, status) VALUES (?,?,?,?,?,?,?,?)`,
    'm_reply',
    's_peer',
    S,
    'reply',
    'm_go',
    'go',
    2000,
    'sent',
  )
  assert.equal(await verdict(S), 'resumable')
  ok('once a reply to the awaited message lands → resumable (trigger re-confirmed)')

  console.log(`\n${passed} assertions passed.`)
} finally {
  cleanup()
}
process.exit(0)
