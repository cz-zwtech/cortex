#!/usr/bin/env tsx
/**
 * Piece 2 (now-slice): GROUPS edge derivation from thread.state.links.
 * The edge is THREAD-OWNED (src=thread, dst=member memory) so it is re-derived
 * on thread re-upsert and SURVIVES a member re-upsert (Decision A — avoids the
 * lossy-round-trip wipe). Plain tsx + node:assert/strict, mirroring
 * test/graph/recall.test.ts's temp-DB harness.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-thread-edge-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, all } = await import('../../server/graph/db.js')
const { upsertEntry, deriveThreadEdgesForChanged } = await import('../../server/graph/sync.js')
getDb()

const mem = (id: string, scope: string, updatedAt: number) =>
  upsertEntry(null, {
    id, name: id, kind: 'memory', description: '', content: `${id} body`,
    source: 'memory', scope, updatedAt, machine: 'm',
  } as any)
const thread = (id: string, links: string[], updatedAt: number) =>
  upsertEntry(null, {
    id, name: id, kind: 'thread', description: 'd',
    content: JSON.stringify({ status: 'open', next_step: '', links }),
    source: 'memory', scope: 'project:A', updatedAt, machine: 'm',
  } as any)

mem('mem-a', 'project:A', 1)
mem('mem-b', 'project:B', 1)
thread('thread:x', ['mem-a', 'mem-b'], 1)

deriveThreadEdgesForChanged(['thread:x'])
const edges = all<{ src: string; dst: string; rel: string }>(
  `SELECT src, dst, rel FROM edges WHERE rel = 'GROUPS' ORDER BY dst`,
)
assert.deepEqual(edges, [
  { src: 'thread:x', dst: 'mem-a', rel: 'GROUPS' },
  { src: 'thread:x', dst: 'mem-b', rel: 'GROUPS' },
], 'thread->member GROUPS edges derived from links')

// DECISION-A ROBUSTNESS: re-upserting a MEMBER must not drop the thread-owned edge.
mem('mem-a', 'project:A', 2)
const after = all<{ dst: string }>(`SELECT dst FROM edges WHERE rel = 'GROUPS' AND src = 'thread:x'`)
assert.equal(after.length, 2, 'member re-upsert must NOT wipe the thread-owned GROUPS edges')

// Re-deriving after a link removal reconciles (mem-b dropped from links).
thread('thread:x', ['mem-a'], 3)
deriveThreadEdgesForChanged(['thread:x'])
const reconciled = all<{ dst: string }>(`SELECT dst FROM edges WHERE rel = 'GROUPS' AND src = 'thread:x'`)
assert.deepEqual(reconciled.map((r) => r.dst), ['mem-a'], 're-derive reconciles removed links')

console.log('thread-edge-derivation: OK')
process.exit(0)
