import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import path from 'node:path'
import { MemoryStore, hashContent, type MemoryInput } from '../server/store.js'

const SCHEMA = path.join(import.meta.dirname, '..', 'schema.sql')

const store = () => {
  const db = new Database(':memory:')
  MemoryStore.applySchema(db, SCHEMA)
  return new MemoryStore(db)
}

const mem = (over: Partial<MemoryInput> = {}): MemoryInput => ({
  id: 'm1',
  source: '/memory/m1.md',
  name: 'A memory',
  description: 'desc',
  content: 'body',
  shape: 'decision',
  authorship: 'authored',
  scope: 'user',
  pinned: false,
  protected: false,
  machine: 'node-a',
  authoredAt: 1000,
  outcome: '',
  outcomeText: '',
  ...over,
})

test('upsert reports created, then unchanged, then updated', () => {
  const s = store()
  assert.equal(s.upsert(mem()).result, 'created')
  // Same content must be a genuine no-op, not a silent rewrite.
  assert.equal(s.upsert(mem()).result, 'unchanged')
  assert.equal(s.upsert(mem({ content: 'different' })).result, 'updated')
})

test('a memory round-trips with its booleans intact', () => {
  const s = store()
  s.upsert(mem({ pinned: true, protected: true }))
  const got = s.get('m1')!
  assert.equal(got.pinned, true)
  assert.equal(got.protected, true)
  assert.equal(got.shape, 'decision')
  assert.equal(got.machine, 'node-a')
})

test('one mailbox yields MANY memories — source is provenance, not identity', () => {
  // This test previously asserted source-as-stable-IDENTITY. The
  // first-class-memory charter un-earned that: an inbox that empties has no
  // stable path-to-memory mapping, so the NEXT write to a path is a DIFFERENT
  // memory. The singular return type was the dead assumption encoded in code.
  const s = store()
  s.upsert(mem({ id: 'first', source: '/memory/inbox.md', ingestedAt: 1 }))
  s.upsert(mem({ id: 'second', source: '/memory/inbox.md', ingestedAt: 2 }))

  assert.deepEqual(
    s.bySource('/memory/inbox.md').map((m) => m.id),
    ['first', 'second'],
    'both writes survive; neither is treated as an update of the other',
  )
})

test('settlement aliases resolve forward, so a settled id cannot resurrect', () => {
  const s = store()
  s.upsert(mem({ id: 'winner' }))
  s.settle('loser', 'winner')

  assert.equal(s.resolveId('loser'), 'winner', 'a stale receipt still resolves')
  assert.equal(s.resolveId('winner'), 'winner', 'an unaliased id passes through')
  assert.equal(s.resolveId('never-settled'), 'never-settled')
})

test('authored_at and ingested_at are DIFFERENT clocks', () => {
  const s = store()
  s.upsert(mem({ authoredAt: 500, ingestedAt: 9000 }))
  const got = s.get('m1')!
  assert.equal(got.authoredAt, 500, 'when the human wrote it')
  assert.equal(got.ingestedAt, 9000, 'when we indexed it')
  assert.notEqual(got.authoredAt, got.ingestedAt)
})

test('THREAD IS A MEMORY, not a hub', () => {
  // V1 disagreed with itself here: decay treated threads as memories, recall
  // dropped them as hubs. A thread carries content and is file-backed, so it
  // lives in `memories`. Suppressing it from ordinary results is a ranking
  // policy, applied elsewhere.
  const s = store()
  s.upsert(mem({ id: 't1', shape: 'thread', content: 'status: in-progress' }))
  const got = s.get('t1')!
  assert.equal(got.shape, 'thread')
  assert.equal(got.content, 'status: in-progress', 'a thread carries authored content')
  assert.equal(s.getHub('t1'), null, 'and is NOT a hub')
})

test('hubs are structurally separate from memories', () => {
  const s = store()
  s.upsertHub({ id: 'file:/a.ts', kind: 'file', name: '/a.ts' })
  assert.equal(s.getHub('file:/a.ts')?.kind, 'file')
  assert.equal(s.get('file:/a.ts'), null, 'a hub is not a memory')
  assert.equal(s.count(), 0, 'hubs do not inflate the memory count')
})

test('declared edges are wiped and rebuilt on re-declaration', () => {
  const s = store()
  s.upsert(mem())
  s.setDeclaredEdges('m1', [
    { src: 'm1', dst: 'file:/a.ts', rel: 'mentions_file' },
    { src: 'm1', dst: 'file:/b.ts', rel: 'mentions_file' },
  ])
  assert.equal(s.declaredEdges('m1').length, 2)

  s.setDeclaredEdges('m1', [{ src: 'm1', dst: 'file:/a.ts', rel: 'mentions_file' }])
  assert.equal(s.declaredEdges('m1').length, 1, 'a retracted declaration is gone')
})

test("re-declaring one memory CANNOT touch another's declared edges", () => {
  // V1's most-guarded invariant (four separate tests). Structural here.
  const s = store()
  s.setDeclaredEdges('m1', [{ src: 'm1', dst: 'shared', rel: 'mentions_file' }])
  s.setDeclaredEdges('m2', [{ src: 'm2', dst: 'shared', rel: 'mentions_file' }])

  s.setDeclaredEdges('m1', [])

  assert.equal(s.declaredEdges('m2').length, 1, "m2's declaration must survive")
  assert.equal(s.inboundDeclared('shared').length, 1)
})

test('OBSERVED edges survive a declared-edge rebuild — history is not lost', () => {
  // The blocker that content-aware re-seeding exists to avoid: surfacing history
  // feeds usage scores and decay, and losing it is invisible and permanent.
  const s = store()
  s.upsert(mem())
  s.observe('m1', 'session:1', 'surfaced_in', 100)
  s.setDeclaredEdges('m1', [])

  const obs = s.observedEdges('m1')
  assert.equal(obs.length, 1, 'observed edges live in their own store for exactly this reason')
  assert.equal(obs[0]?.count, 1)
})

test('repeat observations increment rather than duplicate', () => {
  const s = store()
  s.observe('m1', 'session:1', 'surfaced_in', 100)
  s.observe('m1', 'session:1', 'surfaced_in', 200)
  s.observe('m1', 'session:1', 'surfaced_in', 300)

  const [edge] = s.observedEdges('m1')
  assert.equal(edge?.count, 3)
  assert.equal(edge?.firstAt, 100, 'first-seen is stable')
  assert.equal(edge?.lastAt, 300, 'last-seen advances')
})

test('delete removes declared and derived edges but PRESERVES observed history', () => {
  const s = store()
  s.upsert(mem())
  s.setDeclaredEdges('m1', [{ src: 'm1', dst: 'file:/a.ts', rel: 'mentions_file' }])
  s.setDerivedEdges('m1', [{ src: 'm1', dst: 'm2', rel: 'similar_to', score: 0.9 }])
  s.observe('m1', 'session:1', 'surfaced_in')

  assert.equal(s.delete('m1'), true)
  assert.equal(s.declaredEdges('m1').length, 0)
  assert.equal(s.derivedEdges('m1').length, 0)
  assert.equal(
    s.observedEdges('m1').length,
    1,
    'discarding history must be explicit, never a side effect of delete',
  )
})

test('deleteCascade is the EXPLICIT way to discard history', () => {
  const s = store()
  s.upsert(mem())
  s.observe('m1', 'session:1', 'surfaced_in')
  s.deleteCascade('m1')
  assert.equal(s.observedEdges('m1').length, 0)
})

test('deleting something that does not exist reports false', () => {
  assert.equal(store().delete('nope'), false)
})

test('protected is a generic flag any module can set through a capability', () => {
  const s = store()
  s.upsert(mem())
  assert.equal(s.setProtected('m1', true), true)
  assert.equal(s.get('m1')?.protected, true)
})

test('the consume ledger is keyed by TEXT, not by the mailbox it arrived in', () => {
  const s = store()
  const h = hashContent('A memory', 'desc', 'body')

  assert.equal(s.consumedAs(h), null, 'unseen text is new')
  s.recordConsume(h, 'm1')
  assert.equal(s.consumedAs(h), 'm1', 'the same text resolves to the same memory')

  const h2 = hashContent('A memory', 'desc', 'edited')
  assert.equal(s.consumedAs(h2), null, 'different text is a different consume')
})

test('re-running ingest on the SAME text is idempotent whatever mailbox it lands in', () => {
  // The one property the ledger exists for: the consume protocol must be
  // safely re-runnable after a crash. Same text, two different inboxes.
  const s = store()
  const h = hashContent('A memory', 'desc', 'body')

  s.recordConsume(h, 'm1')
  s.recordConsume(h, 'm1')

  assert.equal(s.consumedAs(h), 'm1', 'a retry produces no second memory')
})

test('search escapes LIKE metacharacters', () => {
  const s = store()
  s.upsert(mem({ id: 'a', source: '/a.md', name: '100% sure' }))
  s.upsert(mem({ id: 'b', source: '/b.md', name: 'anything at all' }))
  // Without escaping, '%' would match everything.
  assert.deepEqual(s.search('100%').map((m) => m.id), ['a'])
})

// ── hub GC ───────────────────────────────────────────────────────────────────
// Hubs never decay — decay is about RELEVANCE and a hub has none to lose. Hub
// lifetime is REFERENTIAL, so GC is an orphan sweep. Memory owns it because
// hubs are memory's traversal structure and it is the only module that can see
// all three edge stores.

test('HUB GC: a hub with edges SURVIVES', () => {
  // The present-and-exercised half. Testing only that orphans are removed would
  // pass on a sweep that deletes everything — the degenerate proof again.
  const s = store()
  s.upsert(mem())
  s.upsertHub({ id: 'file:/live.ts', kind: 'file', name: '/live.ts' })
  s.setDeclaredEdges('m1', [{ src: 'm1', dst: 'file:/live.ts', rel: 'mentions_file' }])

  const result = s.sweepOrphanHubs()

  assert.deepEqual(result.removed, [], 'a referenced hub is live regardless of age')
  assert.equal(s.getHub('file:/live.ts')?.kind, 'file')
})

test('HUB GC: an orphan hub is removed', () => {
  const s = store()
  s.upsertHub({ id: 'file:/orphan.ts', kind: 'file', name: '/orphan.ts' })
  assert.deepEqual(s.sweepOrphanHubs().removed, ['file:/orphan.ts'])
  assert.equal(s.getHub('file:/orphan.ts'), null)
})

test('HUB GC: a hub referenced by an OBSERVED edge survives', () => {
  // Session hubs are reached by observed edges, not declared ones. A sweep that
  // only consulted declared_edges would delete every session hub and take the
  // surfacing history's endpoints with it.
  const s = store()
  s.upsertHub({ id: 'session:1', kind: 'session', name: 'session 1' })
  s.observe('m1', 'session:1', 'surfaced_in')

  assert.deepEqual(s.sweepOrphanHubs().removed, [])
  assert.ok(s.getHub('session:1'))
})

test('HUB GC: a hub referenced by a DERIVED edge survives', () => {
  const s = store()
  s.upsertHub({ id: 'tool:bash', kind: 'tool', name: 'bash' })
  s.setDerivedEdges('m1', [{ src: 'm1', dst: 'tool:bash', rel: 'similar_to', score: 0.5 }])

  assert.deepEqual(s.sweepOrphanHubs().removed, [])
  assert.ok(s.getHub('tool:bash'))
})

test('HUB GC: becoming orphaned is what makes a hub collectable', () => {
  const s = store()
  s.upsertHub({ id: 'file:/x.ts', kind: 'file', name: '/x.ts' })
  s.setDeclaredEdges('m1', [{ src: 'm1', dst: 'file:/x.ts', rel: 'mentions_file' }])
  assert.deepEqual(s.sweepOrphanHubs().removed, [], 'referenced: kept')

  s.setDeclaredEdges('m1', [])
  assert.deepEqual(s.sweepOrphanHubs().removed, ['file:/x.ts'], 'last reference gone: collectable')
})

test('HUB GC: dryRun reports without deleting', () => {
  const s = store()
  s.upsertHub({ id: 'file:/o.ts', kind: 'file', name: '/o.ts' })
  assert.deepEqual(s.sweepOrphanHubs({ dryRun: true }).removed, ['file:/o.ts'])
  assert.ok(s.getHub('file:/o.ts'), 'dryRun must not delete')
})

test('HUB GC: memories are never swept, only hubs', () => {
  const s = store()
  s.upsert(mem()) // no edges at all
  s.sweepOrphanHubs()
  assert.ok(s.get('m1'), 'an edgeless MEMORY is not garbage — it has content')
})

test('a re-ingest never clears standing or protect set by hand; ingest can raise them', async () => {
  const Database = (await import('better-sqlite3')).default
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { MemoryStore, hashContent } = await import('../server/store.js')
  const db = new Database(':memory:')
  db.exec(fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8'))
  const s = new MemoryStore(db)
  const row = (content: string, pinned: boolean) => ({
    id: 'm1', source: '/m/m1.md', name: 'm1', description: '', content, shape: 'feedback', authorship: 'authored', scope: 'user',
    pinned, protected: false, machine: 'x', authoredAt: 1, ingestedAt: 1, outcome: '', outcomeText: '', contentHash: hashContent('m1', '', content),
  })
  s.upsert(row('v1', false) as never)
  s.setStanding('m1', true)
  s.setProtected('m1', true)
  s.upsert(row('v2', false) as never)
  assert.equal(s.get('m1')!.pinned, true)
  assert.equal(s.get('m1')!.protected, true)
  s.setStanding('m1', false)
  assert.equal(s.standing().length, 0)
  s.upsert(row('v3', true) as never)
  assert.deepEqual(s.standing().map((m) => m.id), ['m1'])
})
