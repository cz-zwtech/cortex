#!/usr/bin/env tsx
/**
 * Piece 3 (now-slice): SessionStart cross-objective bucket. Memories from OTHER
 * project scopes bound (GROUPS) to an OPEN thread owned by THIS machine surface
 * at SessionStart — capped, cross-scope only, deduped against already-shown ids.
 * owner = MACHINE (getMachineId) because at SessionStart the session holds no
 * thread claims yet.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-xobj-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb } = await import('../../server/graph/db.js')
const { upsertEntry, deriveThreadEdgesForChanged } = await import('../../server/graph/sync.js')
const { getMachineId } = await import('../../server/privateMind.js')
const { fetchCrossObjectiveBucket } = await import('../../server/capabilitySheet.js')
getDb()
const machine = getMachineId()

const CWD = '/mnt/e/Repos/personal/claude-config-dashboard'

// A memory in ANOTHER project (event-storm), bound to an OPEN thread this machine owns.
upsertEntry(null, {
  id: 'mem-es', name: 'mem-es', kind: 'memory', description: 'event-storm note',
  content: 'y'.repeat(80), source: 'memory',
  scope: 'project:-mnt-e-Repos-personal-event_storm_agents', updatedAt: 5, machine,
} as any)
upsertEntry(null, {
  id: 'thread:t', name: 't', kind: 'thread', description: 'd',
  content: JSON.stringify({ status: 'in-progress', next_step: '', links: ['mem-es'] }),
  source: 'memory', scope: 'project:-mnt-e-Repos-personal', updatedAt: 5, machine,
} as any)
deriveThreadEdgesForChanged(['thread:t'])

// Launching from the cortex folder: the event-storm memory is cross-scope.
const bucket = await fetchCrossObjectiveBucket(CWD, [])
assert.ok(bucket.find((m: any) => m.id === 'mem-es'), 'cross-objective memory bound to an open thread surfaces')
assert.ok(bucket.length <= 5, 'bucket is capped at 5')

// Dedup: an id already shown in another bucket is excluded.
const deduped = await fetchCrossObjectiveBucket(CWD, ['mem-es'])
assert.ok(!deduped.find((m: any) => m.id === 'mem-es'), 'already-shown ids are deduped out')

// In-scope (same-project) memory is NOT cross-objective → not in this bucket.
upsertEntry(null, {
  id: 'mem-here', name: 'mem-here', kind: 'memory', description: 'same project',
  content: 'z'.repeat(80), source: 'memory', scope: 'project:-mnt-e-Repos-personal', updatedAt: 6, machine,
} as any)
upsertEntry(null, {
  id: 'thread:t', name: 't', kind: 'thread', description: 'd',
  content: JSON.stringify({ status: 'in-progress', next_step: '', links: ['mem-es', 'mem-here'] }),
  source: 'memory', scope: 'project:-mnt-e-Repos-personal', updatedAt: 6, machine,
} as any)
deriveThreadEdgesForChanged(['thread:t'])
const b2 = await fetchCrossObjectiveBucket(CWD, [])
assert.ok(!b2.find((m: any) => m.id === 'mem-here'), 'an in-scope project memory is not cross-objective')
assert.ok(b2.find((m: any) => m.id === 'mem-es'), 'the cross-scope one still surfaces')

// DEFECT GUARD: a vault-scoped GROUPS member must NOT appear in bucket 4 — vault
// has its own SessionStart bucket, so listing it here would double-show it.
upsertEntry(null, {
  id: 'mem-vault', name: 'mem-vault', kind: 'memory', description: 'vault note',
  content: 'w'.repeat(80), source: 'memory', scope: 'vault:obsidian', updatedAt: 7, machine,
} as any)
upsertEntry(null, {
  id: 'thread:t', name: 't', kind: 'thread', description: 'd',
  content: JSON.stringify({ status: 'in-progress', next_step: '', links: ['mem-es', 'mem-here', 'mem-vault'] }),
  source: 'memory', scope: 'project:-mnt-e-Repos-personal', updatedAt: 7, machine,
} as any)
deriveThreadEdgesForChanged(['thread:t'])
const b3 = await fetchCrossObjectiveBucket(CWD, [])
assert.ok(!b3.find((m: any) => m.id === 'mem-vault'), 'vault-scoped member must NOT appear in the cross-objective bucket (the vault bucket owns it)')
assert.ok(b3.find((m: any) => m.id === 'mem-es'), 'the cross-scope project member still surfaces')

console.log('cross-objective-bucket: OK')
process.exit(0)
