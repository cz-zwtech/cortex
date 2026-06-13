import { describe, it, expect, beforeEach, afterAll } from '../_tinytest.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Set CKN_GRAPH_DB_PATH before importing db.ts so the singleton opens our temp file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-alias-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')

const { getDb, run } = await import('../../server/graph/db.js')
getDb() // initSchema creates node_aliases

const { setAlias, canonicalId, allAliases } = await import('../../server/graph/nodeAliases.js')

describe('node aliases', () => {
  beforeEach(() => {
    // Clear the table between tests for isolation.
    run('DELETE FROM node_aliases')
  })
  afterAll(() => {
    delete process.env.CKN_GRAPH_DB_PATH
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('canonicalId folds a known alias and is identity otherwise', () => {
    setAlias('node-a-8933b9af', 'node-a-c5e3af1c')
    expect(canonicalId('node-a-8933b9af')).toBe('node-a-c5e3af1c')
    expect(canonicalId('node-a-c5e3af1c')).toBe('node-a-c5e3af1c')
    expect(canonicalId('wsl-dev-test')).toBe('wsl-dev-test')
  })
  it('setAlias is idempotent (upsert)', () => {
    setAlias('a', 'b'); setAlias('a', 'b')
    expect(canonicalId('a')).toBe('b')
    expect(allAliases()).toEqual([{ aliasId: 'a', canonicalId: 'b' }])
  })
})
