#!/usr/bin/env tsx
/**
 * mode-on-claim (#89) round-trip against a temp graph DB: a fresh claim defaults to
 * 'working'; setClaimMode updates the OPEN claim; getOpenClaimForSession reads it back (the
 * PostCompact resume read); release ends the open claim so the mode dies with it. Also
 * exercises the additive migration (ensureClaimModeColumn) via initSchema on first open.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-claim-mode-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')

const { claimThread, setClaimMode, getOpenClaimForSession, releaseThread } = await import(
  '../server/graph/threads.js'
)

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

try {
  const T = 't_resume'
  const S = 's_aaa'
  claimThread(T, S, 1000)
  assert.deepEqual(getOpenClaimForSession(S), { threadId: T, mode: 'working' })
  ok('a fresh claim defaults to mode=working (safe = resumable)')

  setClaimMode(T, S, 'waiting-on:bus=m_42')
  assert.deepEqual(getOpenClaimForSession(S), { threadId: T, mode: 'waiting-on:bus=m_42' })
  ok('setClaimMode updates the open claim mode')

  setClaimMode(T, S, 'quiesced')
  assert.equal(getOpenClaimForSession(S)?.mode, 'quiesced')
  ok('setClaimMode is repeatable on the live claim')

  assert.equal(getOpenClaimForSession('s_none'), null)
  ok('a session with no open claim → null (PostCompact reads this → ambiguous)')

  releaseThread(T, S, 2000)
  assert.equal(getOpenClaimForSession(S), null)
  ok('release ends the open claim — the mode dies with it')

  console.log(`\n${passed} assertions passed.`)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
process.exit(0)
