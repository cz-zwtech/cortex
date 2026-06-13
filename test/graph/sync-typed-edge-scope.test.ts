#!/usr/bin/env tsx
/**
 * commit-1 (sync-saturation) b″ — scope materializeTypedEdges to changed entries.
 *
 * upsertEntry deletes edges WHERE src=id OR dst=id, so re-upserting a changed
 * entry wipes (a) its own outbound edges and (b) inbound edges pointing AT it.
 * The old pass re-materialized ALL ~2.5k entries' pending edges every sync to
 * cover (b). But re-upserting a changed memory only wipes edges that TOUCH that
 * memory — an unchanged entry's MENTIONS_FILE edge (to a file stub) is never
 * affected. So we only need pending edges whose source changed OR whose target
 * is a changed id (reverse-edge lookup). Pure-function so it's unit-testable.
 *
 * Discriminator: an unchanged source whose edges touch no changed id is excluded.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-edgescope-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { scopePendingEdges } = await import('../../server/graph/sync.js')

interface PE {
  from: string
  mentionsFiles: string[]
  mentionsTools: string[]
  resolves: string[]
  contradicts: string[]
  occurredIn: string | null
  evolvedFrom: string | null
  agentId: string
}
const pe = (over: Partial<PE>): PE => ({
  from: 'x', mentionsFiles: [], mentionsTools: [], resolves: [],
  contradicts: [], occurredIn: null, evolvedFrom: null, agentId: '', ...over,
})

const pending: PE[] = [
  pe({ from: 'X', mentionsFiles: ['file-a'] }), // X changed — outbound (wiped by its re-upsert)
  pe({ from: 'U', mentionsFiles: ['file-b'] }), // U unchanged, edge only to a file stub — EXCLUDE
  pe({ from: 'V', contradicts: ['X'] }),        // V→X CONTRADICTS into changed X (wiped) — INCLUDE
  pe({ from: 'W', evolvedFrom: 'X' }),          // EVOLVED_INTO X→W, X changed source (wiped) — INCLUDE
  pe({ from: 'Z', resolves: ['err-unchanged'] }), // Z unchanged → unchanged error — EXCLUDE
]

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. incremental scope: only edges touching a changed id
{
  const scoped = scopePendingEdges(pending, ['X'])
  const froms = new Set(scoped.map((p) => p.from))
  assert.ok(froms.has('X'), 'changed source X included (outbound)')
  assert.ok(froms.has('V'), 'V included — contradicts points AT changed X (inbound restore)')
  assert.ok(froms.has('W'), 'W included — evolvedFrom is changed X')
  assert.ok(!froms.has('U'), 'U excluded — its only edge is to a file stub, untouched by X re-upsert')
  assert.ok(!froms.has('Z'), 'Z excluded — resolves an unchanged error')
  assert.equal(scoped.length, 3, 'exactly the 3 relevant edges')
  ok('scope keeps only pending edges touching a changed id')
}

// ── 2. empty changedIds → nothing to materialize
{
  assert.deepEqual(scopePendingEdges(pending, []), [], 'no changed ids → no edges')
  ok('empty changedIds → empty scope (all-skip sync does no edge work)')
}

// ── 3. null changedIds (empty-graph rebuild) → all edges
{
  assert.equal(scopePendingEdges(pending, null).length, pending.length, 'null → full set')
  ok('null changedIds (rebuild) materializes all')
}

console.log(`\nOK sync-typed-edge-scope.test.ts — ${passed} assertions passed`)
