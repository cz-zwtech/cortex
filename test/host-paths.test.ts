import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { dataRoot, dbPath, hostPaths, modulesDir } from '../core/paths.js'

test('the host runs on the stores its CLIs use, whatever CKN_HOME says (28 Oct)', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hostpaths-'))
  const saved = { home: process.env.CKN_HOME, state: process.env.CKN_STATE_DIR, modules: process.env.CKN_MODULES_DIR, db: process.env.CKN_DB_PATH }
  try {
    process.env.CKN_HOME = '/opt/some/checkout'
    process.env.CKN_STATE_DIR = state
    delete process.env.CKN_MODULES_DIR
    delete process.env.CKN_DB_PATH
    assert.deepEqual(hostPaths(), { modulesDir: modulesDir(), dataRoot: dataRoot(), dbPath: dbPath() })
    assert.ok(Object.values(hostPaths()).every((p) => p.startsWith(state)), 'all under the state dir, none under CKN_HOME')
  } finally {
    for (const [k, v] of [['CKN_HOME', saved.home], ['CKN_STATE_DIR', saved.state], ['CKN_MODULES_DIR', saved.modules], ['CKN_DB_PATH', saved.db]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(state, { recursive: true, force: true })
  }
})

test('core/index.ts takes its paths from hostPaths and reads no home variable of its own', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'core', 'index.ts'), 'utf-8')
  assert.match(src, /hostPaths\(\)/)
  assert.doesNotMatch(src, /CKN_HOME|CKN_STATE_DIR|homedir\(\)/)
})
