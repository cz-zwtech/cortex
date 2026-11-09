/**
 * Memory's replication seams (private mind design 3.1, step 6a): records keep
 * their origin's machine and seq, adopting is idempotent, tombstones and
 * redactions cross machines, feedback lands in user scope, every memory gets a
 * sync class, and dialogue blocks replicate by a per-origin sequence. No
 * network here: two stores, handed each other's streams.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

import { bySession, classify, registerClassifier } from '../server/classify.js'
import { ContextStore } from '../server/context/store.js'
import { adoptRecords, ingest } from '../server/ingest.js'
import { hashContent, Journal, type MemoryRecord } from '../server/journal.js'
import { MemoryStore } from '../server/store.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sync-'))
  dirs.push(d)
  return d
}

const node = (machine: string) => {
  const db = new Database(':memory:')
  db.exec(schema)
  const dir = path.join(tmp(), 'journal')
  return { machine, dir, store: new MemoryStore(db), journal: new Journal({ dir, machine }) }
}
type Node = ReturnType<typeof node>

const write = (n: Node, slug: string, body: string, opts: { scope?: string; type?: string; extra?: string } = {}) => {
  const content = `---\nname: ${slug}\ndescription: ${body}\ntype: ${opts.type ?? 'decision'}\n${opts.extra ?? ''}---\n\n${body}\n`
  const r = ingest({ content, body, slug, scope: opts.scope ?? 'user', source: `/home/u/.claude/memory/${slug}.md`, machine: n.machine, authoredAt: Date.now() }, n)
  assert.equal(r.status, 'ingested')
  return r.status === 'ingested' ? r.receipt.id : ''
}
const sync = (from: Node, to: Node) => adoptRecords([...from.journal.stream(to.journal.versionVector())], to)
const names = (n: Node) => n.store.all().map((m) => m.name).sort()

test('records cross with their origin machine and seq; adopting again, or our own coming back, changes nothing', () => {
  const a = node('mach-a')
  const b = node('mach-b')
  write(a, 'queue-choice', 'The job queue is the append-only log.')
  write(a, 'cache-ttl', 'Cache entries live five minutes.')
  const first = sync(a, b)
  assert.equal(first.added, 2)
  assert.deepEqual(names(b), ['cache-ttl', 'queue-choice'])
  assert.equal(b.journal.versionVector()['mach-a'], 2)
  const moved = b.store.byName('queue-choice')[0]!
  assert.equal(moved.machine, 'mach-a')
  assert.equal(moved.source, 'mach-a:/home/u/.claude/memory/queue-choice.md', 'a foreign row never claims a local path')

  assert.equal(sync(a, b).added, 0, 'nothing new')
  assert.equal(adoptRecords([...a.journal.stream({})], b).added, 0, 'resent in full: still nothing new')

  write(b, 'pool-size', 'The pool is 50 per instance.')
  const back = sync(b, a)
  assert.equal(back.added, 1, "only b's own record; a's records relayed back by b are a's own and ignored")
  assert.deepEqual(names(a), ['cache-ttl', 'pool-size', 'queue-choice'])
})

test('feedback from another machine loads everywhere: user scope, its own scope kept as provenance', () => {
  const a = node('mach-a')
  const b = node('mach-b')
  write(a, 'no-filler-words', 'No filler words, ever.', { scope: '-home-u-work-proj', type: 'feedback' })
  write(a, 'proj-port', 'The project gateway listens on 7300.', { scope: '-home-u-work-proj' })
  sync(a, b)
  const fb = b.store.byName('no-filler-words')[0]!
  assert.equal(fb.scope, 'user')
  assert.ok(b.store.observedEdges(fb.id).some((e) => e.dst === 'scope:-home-u-work-proj' && e.rel === 'origin_scope'))
  assert.equal(b.store.byName('proj-port')[0]!.scope, '-home-u-work-proj', 'only feedback moves to user scope')
})

test('a record altered on the way is refused; a malformed one too', () => {
  const a = node('mach-a')
  const b = node('mach-b')
  write(a, 'queue-choice', 'The job queue is the append-only log.')
  const [rec] = [...a.journal.stream({})] as MemoryRecord[]
  const r = adoptRecords([{ ...rec, content: rec!.content.replace('append-only log', 'broker') }, { kind: 'memory', seq: 'x' }], b)
  assert.deepEqual([r.added, r.rejected], [0, 2])
  assert.equal(b.store.all().length, 0)
})

test('a deletion crosses machines, and a later re-save of the same fact survives it', () => {
  const a = node('mach-a')
  const b = node('mach-b')
  const id = write(a, 'old-port', 'The gateway listens on 7300.')
  sync(a, b)
  assert.equal(names(b).length, 1)
  a.journal.appendTombstone({ memoryId: id, targetHash: a.store.journalHashOf(id)!, machine: 'mach-a' })
  a.store.deleteCascade(id)
  const r = sync(a, b)
  assert.equal(r.removed, 1)
  assert.equal(b.store.all().length, 0)
  assert.equal(b.journal.replay().length, 0)

  write(a, 'old-port', 'The gateway listens on 7300.')
  sync(a, b)
  assert.deepEqual(names(b), ['old-port'], 'written again after the deletion, so it lives')
})

test('a redaction made anywhere removes the text everywhere, and a resend of it is kept only as a gap', () => {
  const a = node('mach-a')
  const b = node('mach-b')
  const id = write(a, 'leaky', 'The staging password is hunter2-but-longer.')
  write(a, 'fine', 'Nothing secret here.')
  sync(a, b)
  const hash = a.store.journalHashOf(id)!
  const [leaky] = [...a.journal.stream({})].filter((r) => r.kind === 'memory' && r.contentHash === hash)
  a.journal.redact(hash, { note: 'pasted secret' })
  a.store.deleteCascade(id)
  sync(a, b)
  assert.deepEqual(names(b), ['fine'])
  const onDisk = fs.readdirSync(path.join(b.dir, 'peers')).map((f) => fs.readFileSync(path.join(b.dir, 'peers', f), 'utf-8'))
  assert.ok(!onDisk.join('').includes('hunter2'), "gone from b's copy of a's records too")
  assert.equal(adoptRecords([leaky], b).added, 0, 'already seen: a resend is not kept again')
  assert.equal(names(b).join(), 'fine')
})

test('the sync class: own frontmatter first, then registered rules, then the kind of session', () => {
  const c = (content: string, session?: Parameters<typeof bySession>[0]) => classify({ content, scope: 'user', shape: 'decision', ...(session ? { session } : {}) })
  assert.equal(c('---\nname: x\nsync: local\n---\nbody', { entrypoint: 'cli' }), 'working')
  assert.equal(c('---\nname: x\nsync: shared\n---\nbody', { entrypoint: 'cli', parent: 'p' }), 'knowledge')
  assert.equal(c('body', { entrypoint: 'cli' }), 'knowledge', 'an interactive lead session')
  assert.equal(c('body'), 'knowledge', 'no session: written by hand')
  assert.equal(c('body', { entrypoint: 'cli', parent: 'lead' }), 'working', 'a subagent')
  assert.equal(c('body', { entrypoint: 'cli', agent: 'builder' }), 'working', 'a named agent')
  assert.equal(c('body', { entrypoint: 'sdk-cli' }), 'working', 'a headless run')
  const stop = registerClassifier((r) => (r.content.includes('code map') ? 'working' : undefined))
  assert.equal(c('a code map of the repo', { entrypoint: 'cli' }), 'working')
  stop()
  assert.equal(c('a code map of the repo', { entrypoint: 'cli' }), 'knowledge')
})

test('ingest records the sync class from the writing session, and tells listeners', () => {
  const a = node('mach-a')
  const told: string[] = []
  const deps = { ...a, sessionInfo: (s: string) => (s === 'sub-1' ? { entrypoint: 'cli', parent: 'lead-1' } : { entrypoint: 'cli' }), onIngested: (r: { id: string; record: MemoryRecord }) => told.push(`${r.id}:${r.record.syncClass}`) }
  const mk = (slug: string, sessionId: string) =>
    ingest({ content: `---\nname: ${slug}\n---\n\n${slug} body`, body: `${slug} body`, slug, scope: 'user', source: `/m/${slug}.md`, machine: 'mach-a', authoredAt: 1, sessionId }, deps)
  mk('from-sub', 'sub-1')
  mk('from-lead', 'lead-1')
  const byName = Object.fromEntries((a.journal.replay() as MemoryRecord[]).map((r) => [r.slug, r.syncClass]))
  assert.deepEqual(byName, { 'from-sub': 'working', 'from-lead': 'knowledge' })
  assert.equal(told.length, 2)
  assert.match(told[0]!, /:working$/)
})

test('dialogue blocks cross by a per-origin sequence; a block that grows is sent again; text is scanned again on arrival', () => {
  const a = new ContextStore(path.join(tmp(), 'context.sqlite'))
  const b = new ContextStore(path.join(tmp(), 'context.sqlite'))
  a.apply('mach-a', 's1', { key: 'k1', uuid: 'u1', speaker: 'user', at: 1, text: 'Why the log and not a broker?' })
  a.apply('mach-a', 's1', { key: 'k2', uuid: 'u2', speaker: 'assistant', at: 2, text: 'Ordering per key matters most.' })
  b.apply('mach-b', 's9', { key: 'k1', uuid: 'u1', speaker: 'user', at: 3, text: 'b own' })
  const first = b.adoptBlocks(a.streamBlocks(b.blockVector()), 'mach-b')
  assert.deepEqual(first, { added: 2, updated: 0, rejected: 0 })
  assert.equal(b.blockVector()['mach-a'], 2)
  assert.equal(b.search('broker')[0]?.machine, 'mach-a', 'searchable on arrival')

  a.apply('mach-a', 's1', { key: 'k2', uuid: 'u3', speaker: 'assistant', at: 2, text: 'And replay is free.' })
  const grown = a.streamBlocks(b.blockVector())
  assert.equal(grown.length, 1, 'only the block that changed')
  assert.deepEqual(b.adoptBlocks(grown, 'mach-b'), { added: 0, updated: 1, rejected: 0 })
  assert.match(b.search('replay')[0]!.text, /Ordering per key[\s\S]*replay is free/)

  const planted = 'sk-ant-api03-PLANTEDsyntheticVALUE0123456789abcdef'
  b.adoptBlocks([{ machine: 'mach-c', session: 's2', seq: 1, key: 'k', speaker: 'user', at: 4, text: `key ${planted}`, boundary: 0, source: 'transcript', party: null, mseq: 1 }], 'mach-b')
  assert.ok(!b.streamBlocks({}).some((x) => x.text.includes(planted)), 'redacted here, whatever the origin missed')
  assert.equal(b.adoptBlocks(b.streamBlocks({}).filter((x) => x.machine === 'mach-b'), 'mach-b').added, 0, 'our own never re-adopted')
  a.close()
  b.close()
})

test('two journal instances on one directory never give out the same seq (28 Oct)', () => {
  const dir = path.join(tmp(), 'journal')
  const hook = new Journal({ dir, machine: 'mach-a' })
  const host = new Journal({ dir, machine: 'mach-a' })
  const content = '---\nname: x\n---\n\nbody'
  const m = hook.appendMemory({ slug: 'x', source: '/m/x.md', scope: 'user', machine: 'mach-a', authoredAt: 1, content })
  const t = host.appendTombstone({ memoryId: 'x', targetHash: m.contentHash, machine: 'mach-a' })
  const c = hook.appendConsolidation({ run: 'r', op: 'facet', args: {}, machine: 'mach-a' })
  const r = host.appendRedaction({ targetHash: 'other' })
  assert.deepEqual([m.seq, t.seq, c.seq, r.seq], [1, 2, 3, 4])
  assert.equal(new Journal({ dir, machine: 'mach-a' }).replay().length, 0, 'the tombstone came after the memory, so it holds')
})

test('a long-running instance\'s version vector counts records another process appended since (2 Nov)', () => {
  const dir = path.join(tmp(), 'journal')
  const host = new Journal({ dir, machine: 'mach-a' })
  assert.equal(host.versionVector()['mach-a'], 0)
  const hook = new Journal({ dir, machine: 'mach-a' })
  const content = '---\nname: x\n---\n\nbody'
  hook.appendMemory({ slug: 'x', source: '/m/x.md', scope: 'user', machine: 'mach-a', authoredAt: 1, content })
  hook.appendMemory({ slug: 'y', source: '/m/y.md', scope: 'user', machine: 'mach-a', authoredAt: 2, content: content.replace('x', 'y') })
  assert.equal(host.versionVector()['mach-a'], 2, 'the host sees the hook\'s writes')
})

test('verify: a memory in the journal whose graph row is gone is found and repaired; a checkpoint is never counted', async () => {
  const { verify } = await import('../server/verify.js')
  const n = node('mach-a')
  write(n, 'deploy-plan', 'Deploy on Tuesdays.')
  write(n, 'cache-ttl', 'Cache entries live five minutes.')
  const checkpoint = '---\nid: session:-x/abc\nname: session-abc\ndescription: Session ended\n---\n\nturns'
  ingest({ content: checkpoint, body: 'turns', slug: 'session-abc', scope: 'user', source: '/m/session-abc.md', machine: 'mach-a', authoredAt: 3, declaredId: 'session:-x/abc' }, n)
  const gone = n.store.all().find((m) => m.name === 'deploy-plan')!
  n.store.delete(gone.id) // the row lost, the journal record kept
  n.store.delete(n.store.all().find((m) => m.name === 'session-abc')!.id)
  const r = verify(n.store, n.journal, 'mach-a')
  assert.deepEqual(r.missing.map((m) => m.slug), ['deploy-plan'])
  assert.equal(r.repaired.length, 0, 'reporting changes nothing')
  const fixed = verify(n.store, n.journal, 'mach-a', { repair: true })
  assert.equal(fixed.repaired.length, 1)
  assert.ok(n.store.all().some((m) => m.name === 'deploy-plan'), 'recallable again')
  assert.equal(n.store.all().find((m) => m.name === 'deploy-plan')!.source, '/home/u/.claude/memory/deploy-plan.md', 'its own path, not machine-prefixed')
  assert.deepEqual(verify(n.store, n.journal, 'mach-a').missing, [], 'and nothing left to find')
})
