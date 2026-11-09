import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { claudeConfigDir, guardRoot, memoryRoots, stateDir } from '../core/paths.js'

// Fail closed: under a test runner, nothing may resolve to a real root.
test('under test, the real home roots are refused, whoever forgot to isolate', () => {
  const real = { ...process.env, CLAUDE_CONFIG_DIR: undefined, HOME: os.homedir() }
  assert.throws(() => claudeConfigDir({ ...real, CLAUDE_CONFIG_DIR: undefined }), /refusing the harness config dir/)
  assert.throws(() => guardRoot(path.join(os.homedir(), '.config', 'ckn'), 'the Cortex state dir'), /refusing/)
})

test('under test, temp roots pass', () => {
  const tmp = path.join(os.tmpdir(), 'cortex-guard-x')
  assert.equal(guardRoot(tmp, 'x'), tmp)
})

test('outside a test the guard is inert', () => {
  const real = path.join(os.homedir(), '.claude')
  assert.equal(guardRoot(real, 'x', { NODE_TEST_CONTEXT: undefined } as NodeJS.ProcessEnv), real)
})

test('the resolvers in use are guarded', () => {
  const saved = { ...process.env }
  try {
    delete process.env.CKN_STATE_DIR
    delete process.env.CKN_MEMORY_DIRS
    delete process.env.CLAUDE_CONFIG_DIR
    assert.throws(() => stateDir(), /refusing/)
    assert.throws(() => memoryRoots(), /refusing/)
  } finally {
    Object.assign(process.env, saved)
  }
})
