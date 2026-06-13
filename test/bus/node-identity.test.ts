import { describe, it, expect, beforeEach, afterEach } from '../_tinytest.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getMachineId } from '../../server/privateMind.js'

// getMachineId reads env + files at CALL time — no module-level id cache.
// Each test sets CKN_NODE_ID_PATH to a fresh tmpdir before calling so the
// anchor path and env override are both resolved at call time, keeping cases
// hermetic without needing per-test module re-imports.

describe('getMachineId — pinned anchor', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-nodeid-'))
    process.env.CKN_NODE_ID_PATH = path.join(dir, 'node-id')
    delete process.env.CKN_NODE_ID
  })
  afterEach(() => {
    delete process.env.CKN_NODE_ID_PATH
    delete process.env.CKN_NODE_ID
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('CKN_NODE_ID env always wins', () => {
    process.env.CKN_NODE_ID = 'pinned-override'
    expect(getMachineId()).toBe('pinned-override')
  })

  it('an existing anchor file is authoritative (no re-derivation)', () => {
    fs.writeFileSync(process.env.CKN_NODE_ID_PATH!, 'node-a-frozen99\n')
    expect(getMachineId()).toBe('node-a-frozen99')
  })

  it('mints once and persists to the anchor when absent', () => {
    const first = getMachineId()
    expect(first).toMatch(/-[0-9a-f]{8}$/) // hostname-8hex (derived) or random
    expect(fs.readFileSync(process.env.CKN_NODE_ID_PATH!, 'utf-8').trim()).toBe(first)
    // A second call returns the SAME pinned value from the anchor.
    expect(getMachineId()).toBe(first)
  })
})
