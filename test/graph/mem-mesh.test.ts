#!/usr/bin/env tsx
/**
 * M4 mem replication: schema, applyMemory, record/emit, ingest idempotency, tombstone receive-path, backfill.
 * Tombstone coverage is the RECEIVE/apply path only (a peer's `deletedAt` frame removes the local .md + entry);
 * tombstone ORIGINATION (local delete → emit a tombstone frame) is deferred to M4.1 and not exercised here.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-memmesh-'))
process.env.CKN_EMBEDDINGS = 'off'
process.env.CKN_GRAPH_DB_PATH = path.join(tmp, 'graph.sqlite')
process.env.CKN_NODE_ID = 'node-test'
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-home-'))
process.env.CKN_HOME = fakeHome  // memoryHome() = CKN_HOME || os.homedir(); used by memMesh AND the sync route so homes are isolatable in tests/gates

const { getDb, all, run } = await import('../../server/graph/db.js')
getDb()
let passed = 0; const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

try {
  run(`INSERT INTO mem_log (id, repo_path, scope, content, content_hash, machine, origin_node, mem_seq)
       VALUES ('m1','memory/user/foo.md','user','---\nname: foo\n---\nbody','h1','mach-a','node-a',1)`)
  const row = all<any>(`SELECT * FROM mem_log WHERE id='m1'`)[0]
  assert.equal(row.origin_node, 'node-a'); assert.equal(row.mem_seq, 1)
  ok('mem_log round-trips')

  const { applyMemory } = await import('../../server/graph/memMesh.js')
  const md = '---\nid: mem-apply-1\nname: Apply Test\ntype: decision\nmachine: mach-a\n---\nThe decision body.'
  await applyMemory('memory/user/apply-test.md', md)
  // .md written under the fake home
  const written = fs.readFileSync(path.join(fakeHome, '.claude', 'memory', 'apply-test.md'), 'utf8')
  assert.ok(written.includes('The decision body.'), 'wrote the .md to the user memory dir')
  // entry indexed with lineage preserved
  const e = all<any>(`SELECT id, name, kind, machine FROM entries WHERE id='mem-apply-1'`)[0]
  assert.equal(e.name, 'Apply Test'); assert.equal(e.kind, 'decision')
  assert.equal(e.machine, 'mach-a', 'machine lineage preserved verbatim')
  ok('applyMemory writes .md + indexes entry with lineage')

  const { recordLocalMemory, ingestMeshMemory, onBusMemory, getMemCursor } = await import('../../server/graph/memMesh.js')
  // local origination stamps origin=node-test + seq, emits once
  const emitted: any[] = []
  const unsub = onBusMemory((m: any) => emitted.push(m))
  const r1 = recordLocalMemory({ id: 'mem-x', repoPath: 'memory/user/x.md', scope: 'user',
    content: '---\nid: mem-x\nname: X\nmachine: node-test\n---\nv1', machine: 'node-test' })
  assert.equal(r1.emitted, true, 'fresh local memory emits')
  assert.equal(emitted.length, 1); assert.equal(emitted[0].originNode, 'node-test')
  // re-record identical content → no emit (idempotent)
  const r2 = recordLocalMemory({ id: 'mem-x', repoPath: 'memory/user/x.md', scope: 'user',
    content: '---\nid: mem-x\nname: X\nmachine: node-test\n---\nv1', machine: 'node-test' })
  assert.equal(r2.emitted, false, 'unchanged content does not re-emit')
  ok('recordLocalMemory stamps origin+seq and emits only on change')

  // ingest a peer memory (different origin) → applies + advances nothing locally re-stamped
  await ingestMeshMemory({ id: 'mem-peer', repoPath: 'memory/user/peer.md', scope: 'user',
    content: '---\nid: mem-peer\nname: Peer\nmachine: node-b\n---\nfrom B', contentHash: '',
    machine: 'node-b', originNode: 'node-b', memSeq: 5, deletedAt: 0 }, 'node-b')
  const pe = all<any>(`SELECT origin_node, mem_seq FROM mem_log WHERE id='mem-peer'`)[0]
  assert.equal(pe.origin_node, 'node-b', 'ingest preserves sender origin'); assert.equal(pe.mem_seq, 5)
  const applied = all<any>(`SELECT name FROM entries WHERE id='mem-peer'`)[0]
  assert.equal(applied.name, 'Peer', 'ingested memory applied to graph')
  ok('ingestMeshMemory preserves sender origin/seq + applies')

  // tombstone receive-path: a peer's deletedAt frame for an existing id removes the local .md + entry.
  // (Origination — local delete → tombstone frame — is deferred to M4.1 and not exercised here.)
  const peerMd = path.join(fakeHome, '.claude', 'memory', 'peer.md')
  assert.ok(fs.existsSync(peerMd), 'precondition: mem-peer .md exists before tombstone')
  assert.ok(all<any>(`SELECT id FROM entries WHERE id='mem-peer'`)[0], 'precondition: mem-peer entry exists before tombstone')
  await ingestMeshMemory({ id: 'mem-peer', repoPath: 'memory/user/peer.md', scope: 'user',
    content: '', contentHash: '', machine: 'node-b', originNode: 'node-b', memSeq: 6, deletedAt: Date.now() }, 'node-b')
  assert.equal(fs.existsSync(peerMd), false, 'tombstone removed the local .md')
  assert.equal(all<any>(`SELECT id FROM entries WHERE id='mem-peer'`)[0], undefined, 'tombstone removed the entries row')
  ok('ingestMeshMemory tombstone removes .md + entry')
  unsub()

  const { localToRepoMemoryPath } = await import('../../server/graph/memMesh.js')
  assert.equal(localToRepoMemoryPath(path.join(fakeHome, '.claude/memory/foo.md')), 'memory/user/foo.md',
    'local→repo path maps user scope')
  ok('localToRepoMemoryPath maps user/concepts/proj')

  console.log(`\n${passed} assertions passed.`)
} finally { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(fakeHome, { recursive: true, force: true }) }
