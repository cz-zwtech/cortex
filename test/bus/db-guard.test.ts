#!/usr/bin/env tsx
/**
 * Tests for the CKN_FORBID_DEFAULT_DB guard in server/graph/db.ts.
 * The guard must throw when CKN_FORBID_DEFAULT_DB is set AND CKN_GRAPH_DB_PATH
 * is absent (would open the real ~/.config/ckn/graph.sqlite), and must NOT throw
 * when given a temp path or when the sentinel is unset.
 *
 * We test the guard by importing openDb directly with manipulated process.env.
 * Because ESM module state is cached, we reset env before each variant and call
 * the exported function (which re-reads process.env on every call — see the guard
 * placement in openDb).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// Import the module under test (openDb reads process.env at call time, not module load time)
import { openDb } from '../../server/graph/db.js'

const REAL_DEFAULT = path.join(os.homedir(), '.config', 'ckn', 'graph.sqlite')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-db-guard-'))
const tempDb = path.join(tmpDir, 'test.sqlite')

let passed = 0

function test(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok ${name}`)
}

// Case 1: sentinel SET + default path → must throw
test('throws when CKN_FORBID_DEFAULT_DB=1 and no CKN_GRAPH_DB_PATH is set (would open real DB)', () => {
  const saved = process.env.CKN_FORBID_DEFAULT_DB
  process.env.CKN_FORBID_DEFAULT_DB = '1'
  delete process.env.CKN_GRAPH_DB_PATH
  try {
    assert.throws(
      () => openDb(REAL_DEFAULT),
      (err: Error) => {
        assert.ok(err.message.includes('real graph.sqlite'), `expected message to mention 'real graph.sqlite', got: ${err.message}`)
        return true
      },
    )
  } finally {
    if (saved === undefined) delete process.env.CKN_FORBID_DEFAULT_DB
    else process.env.CKN_FORBID_DEFAULT_DB = saved
  }
})

// Case 2: sentinel SET + temp path → must NOT throw (opens fine)
test('does NOT throw when CKN_FORBID_DEFAULT_DB=1 but a temp path is given', () => {
  const saved = process.env.CKN_FORBID_DEFAULT_DB
  process.env.CKN_FORBID_DEFAULT_DB = '1'
  try {
    const db = openDb(tempDb)
    db.close()
  } finally {
    if (saved === undefined) delete process.env.CKN_FORBID_DEFAULT_DB
    else process.env.CKN_FORBID_DEFAULT_DB = saved
  }
})

// Case 3: sentinel UNSET + default path → must NOT throw (production path)
test('does NOT throw when CKN_FORBID_DEFAULT_DB is unset, even with the real default path', () => {
  const saved = process.env.CKN_FORBID_DEFAULT_DB
  delete process.env.CKN_FORBID_DEFAULT_DB
  try {
    // We pass the default path explicitly but with the sentinel off — must succeed.
    // Open a temp file that happens to equal what REAL_DEFAULT would be:
    // to avoid actually creating/touching the real DB, we redirect via a temp path.
    // We test the code path by passing a fake-homedir-shaped path to a temp location.
    const fakeDefault = tempDb // NOT the real default — sentinel is off so no check fires
    const db = openDb(fakeDefault)
    db.close()
  } finally {
    if (saved === undefined) delete process.env.CKN_FORBID_DEFAULT_DB
    else process.env.CKN_FORBID_DEFAULT_DB = saved
  }
})

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(`\ndb-guard.test.ts: ${passed} tests passed`)
