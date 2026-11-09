/**
 * Sync bundles between in-process nodes (step 6c-1): what leaves a machine,
 * and that it fails closed. No network: each node's bundle is handed to the
 * next as NDJSON text, as the transport will carry it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

import { frontmatterOf } from '../../memory/server/frontmatter.js'
import { ContextStore } from '../../memory/server/context/store.js'
import { adoptRecords, ingest } from '../../memory/server/ingest.js'
import { Journal } from '../../memory/server/journal.js'
import { MemoryStore } from '../../memory/server/store.js'
import { fromNdjson, toNdjson } from '../server/bundle.js'
import { MindConfigSchema } from '../server/config.js'
import { MindStore, UNRESOLVED_GRACE_MS } from '../server/store.js'
import { makeBundle, takeBundle, type Ports } from '../server/sync.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'memory', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bundle-'))
  dirs.push(d)
  return d
}

const cfg = MindConfigSchema.parse({ central: 'node-b', localRoles: ['contoso'], localDirs: ['/home/u/contoso-guide'] })

const node = (machine: string) => {
  const dir = tmp()
  const db = new Database(':memory:')
  db.exec(schema)
  const store = new MemoryStore(db)
  const journal = new Journal({ dir: path.join(dir, 'journal'), machine })
  const context = new ContextStore(path.join(dir, 'context.sqlite'))
  const mind = new MindStore(path.join(dir, 'mind'))
  /** session -> roles; absent means comms cannot say; in `unbound`, never bound to a member. */
  const roles = new Map<string, string[]>()
  const unbound = new Set<string>()
  const kinds = new Map<string, { entrypoint?: string; parent?: string; cwd?: string }>()
  const ports: Ports = {
    versionVector: () => journal.versionVector(),
    journalStream: (since) => [...journal.stream(since)] as never,
    journalAdopt: (records) => adoptRecords(records, { store, journal }),
    blockVector: () => context.blockVector(),
    blockStream: (since) => context.streamBlocks(since) as never,
    blockAdopt: (blocks) => context.adoptBlocks(blocks, machine),
    shapeOf: (c: string) => frontmatterOf(c).shape,
    sessionRoles: async (s) => (unbound.has(s) ? { bound: false } : roles.has(s) ? { bound: true, member: `${s}-m`, roles: roles.get(s) } : undefined),
    sessionInfo: (s) => kinds.get(s),
  }
  const write = (slug: string, body: string, session?: string, scope = 'user') => {
    const content = `---\nname: ${slug}\ndescription: ${body}\ntype: decision\n---\n\n${body}\n`
    const r = ingest(
      { content, body, slug, scope, source: `/home/u/.claude/memory/${slug}.md`, machine, authoredAt: Date.now(), ...(session ? { sessionId: session } : {}) },
      { store, journal, sessionInfo: (s) => kinds.get(s) },
    )
    assert.equal(r.status, 'ingested')
    return r.status === 'ingested' ? r.receipt.id : ''
  }
  const say = (session: string, key: string, text: string) => context.apply(machine, session, { key, uuid: key, speaker: 'user', at: Date.now(), text })
  return { machine, dir, store, journal, context, mind, roles, unbound, kinds, ports, write, say }
}
type Node = ReturnType<typeof node>

/** One sync: `to` says what it holds, `from` makes the bundle, the text crosses, `to` takes it in. */
const sync = async (from: Node, to: Node, now?: number) => {
  const b = await makeBundle({ ports: from.ports, store: from.mind, cfg, self: from.machine, since: { vv: to.ports.versionVector(), bvv: to.ports.blockVector() }, ...(now ? { now } : {}) })
  const text = toNdjson(b.lines)
  const applied = takeBundle({ ports: to.ports, store: to.mind, lines: fromNdjson(text).lines })
  return { ...b, text, applied }
}
const names = (n: Node) => n.store.all().map((m) => m.name).sort()
const onDisk = (n: Node) =>
  [path.join(n.dir, 'journal'), path.join(n.dir, 'journal', 'peers')]
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.ndjson')).map((f) => fs.readFileSync(path.join(d, f), 'utf-8')))
    .join('')

test('knowledge from a known writer goes; a local role keeps its memories home, and its deletions with them', async () => {
  const a = node('node-a')
  const b = node('node-b')
  a.roles.set('s-pm', ['pm'])
  a.roles.set('s-contoso', ['contoso'])
  a.kinds.set('s-pm', { entrypoint: 'cli' })
  a.kinds.set('s-contoso', { entrypoint: 'cli' })
  a.write('queue-choice', 'The job queue is the append-only log.', 's-pm')
  const contoso = a.write('contoso-case', 'Case 4471 concerns a neighbour dispute.', 's-contoso')
  a.write('cache-ttl', 'Cache entries live five minutes.')
  const r = await sync(a, b)
  assert.deepEqual(names(b), ['cache-ttl', 'queue-choice'])
  assert.match(r.held.map((h) => h.why).join(), /kept home: written in a local role \(contoso\)/)
  assert.equal(b.journal.versionVector()['node-a'], 3, 'the held one went as a gap, so the vector passes it')
  assert.ok(!r.text.includes('4471') && !onDisk(b).includes('4471'), 'its text never left')

  a.journal.appendTombstone({ memoryId: contoso, targetHash: a.store.journalHashOf(contoso)!, machine: 'node-a' })
  const r2 = await sync(a, b)
  assert.ok(!r2.text.includes(contoso) && !r2.text.includes('contoso-case'), 'nor did its deletion, which would have named it')
  assert.equal(b.journal.versionVector()['node-a'], 4)
})

test('a writer comms cannot name holds its memory back, without stopping what comes after; it goes once the writer is known', async () => {
  const a = node('node-a')
  const b = node('node-b')
  a.write('first', 'The first fact, by hand.')
  a.write('unknown-writer', 'Written in a session comms does not know yet.', 's-new')
  a.write('third', 'The third fact, by hand.')
  const r = await sync(a, b)
  assert.deepEqual(names(b), ['first', 'third'])
  assert.equal(r.waitingFrom, 2)
  assert.equal(b.journal.versionVector()['node-a'], 1, 'the receiver stops below the held record')

  a.roles.set('s-new', ['pm'])
  await sync(a, b)
  assert.deepEqual(names(b), ['first', 'third', 'unknown-writer'])
  assert.equal(b.journal.versionVector()['node-a'], 3)
})

test('a writer still unknown after the grace is given up on: held for good, listed, and the stream moves on', async () => {
  const a = node('node-a')
  const b = node('node-b')
  a.write('orphan', 'Written in a session nobody can place.', 's-gone')
  a.write('later', 'Written later, by hand.')
  const t0 = Date.now()
  await sync(a, b, t0)
  const r = await sync(a, b, t0 + UNRESOLVED_GRACE_MS + 60_000)
  assert.deepEqual(names(b), ['later'])
  assert.match(r.held[0]!.why, /could not be found/)
  assert.equal(b.journal.versionVector()['node-a'], 2)
  assert.deepEqual(a.mind.heldWriters().map((w) => w.state), ['unresolvable'])
})

test('working detail stays home: a pointer travels, its text does not', async () => {
  const a = node('node-a')
  const b = node('node-b')
  a.roles.set('s-lead', ['dev'])
  a.kinds.set('s-sub', { entrypoint: 'cli', parent: 's-lead' })
  a.write('build-trace', 'The build failed on step 4 because of a stale lockfile.', 's-sub')
  const r = await sync(a, b)
  assert.equal(names(b).length, 0)
  assert.deepEqual(b.mind.pointers().map((p) => [p.memory, p.slug, p.owner.node]), [['node-a:1', 'build-trace', 'node-a']])
  assert.match(b.mind.pointers()[0]!.summary, /stale lockfile/, 'the one-line summary travels')
  assert.ok(!onDisk(b).includes('step 4 because'), 'the memory itself stays home')
  assert.equal(r.applied.pointers, 1)
})

test('a redaction of a memory that went always goes, and scrubs it at the receiver', async () => {
  const a = node('node-a')
  const b = node('node-b')
  const id = a.write('leaky', 'The staging password is hunter2-but-longer.')
  await sync(a, b)
  a.journal.redact(a.store.journalHashOf(id)!, { note: 'pasted secret' })
  a.store.deleteCascade(id)
  await sync(a, b)
  assert.deepEqual(names(b), [])
  assert.ok(!onDisk(b).includes('hunter2'))
})

test('central passes records on with their holes, so a third node converges', async () => {
  const a = node('node-a')
  const b = node('node-b')
  const c = node('node-c')
  a.roles.set('s-contoso', ['contoso'])
  a.write('one', 'One.')
  a.write('private', 'Contoso only.', 's-contoso')
  a.write('three', 'Three.')
  await sync(a, b)
  await sync(b, c)
  assert.deepEqual(names(c), ['one', 'three'])
  assert.equal(c.journal.versionVector()['node-a'], 3, 'the hole went on too')
  assert.ok(!onDisk(c).includes('Contoso only'))
})

test('dialogue follows its session: knowledge sessions with a known writer only', async () => {
  const a = node('node-a')
  const b = node('node-b')
  a.roles.set('s-pm', ['pm'])
  a.roles.set('s-contoso', ['contoso'])
  a.roles.set('s-sub', ['dev'])
  a.kinds.set('s-sub', { parent: 's-pm' })
  a.say('s-pm', 'k1', 'Why the log and not a broker?')
  a.say('s-contoso', 'k2', 'The neighbour at number 12 complained again.')
  a.say('s-sub', 'k3', 'Running the build in the worktree now.')
  a.say('s-unknown', 'k4', 'Who am I?')
  await sync(a, b)
  assert.deepEqual(b.context.streamBlocks({}).map((x) => x.session), ['s-pm'])
})

test('a bundle taken twice, or resent whole, changes nothing more', async () => {
  const a = node('node-a')
  const b = node('node-b')
  a.write('one', 'One.')
  const r = await sync(a, b)
  const again = takeBundle({ ports: b.ports, store: b.mind, lines: fromNdjson(r.text).lines })
  assert.equal(again.records.added, 0)
  assert.deepEqual(fromNdjson('not json\n{"t":"x"}\n').bad, 2)
})

test('a redaction of a memory kept home stays home too, even once the redaction has removed it here', async () => {
  const a = node('node-a')
  const b = node('node-b')
  a.roles.set('s-contoso', ['contoso'])
  const id = a.write('contoso-secret', 'Case 9 has a pasted token in it.', 's-contoso')
  await sync(a, b)
  a.journal.redact(a.store.journalHashOf(id)!, { memoryId: id, note: 'contoso-secret had a token' })
  a.store.deleteCascade(id)
  const r = await sync(a, b)
  assert.ok(!r.text.includes('contoso-secret'), 'neither the target id nor the note left')
  assert.equal(b.journal.versionVector()['node-a'], 2, 'it went as a gap')
})

test('who wrote it: never bound ships, a member gone is held, a subagent writes for its parent', async () => {
  const a = node('node-a')
  const b = node('node-b')
  a.unbound.add('s-plain')
  a.write('plain', 'Written in a session that never joined a role.', 's-plain')
  a.roles.set('s-contoso', ['contoso'])
  a.write('contoso-sub', 'A contoso subagent found the ward boundaries.', 's-contoso/agent-1')
  a.kinds.set('s-sub2', { parent: 's-contoso' })
  a.write('contoso-sub2', 'Another contoso subagent, known by its parent field.', 's-sub2')
  a.write('orphan-sub', 'A subagent of a session comms cannot place.', 's-lost/agent-9')
  const r = await sync(a, b)
  assert.deepEqual(names(b), ['plain'])
  const codes = Object.fromEntries(r.held.map((h) => [h.record, h.code]))
  assert.deepEqual(codes, { 'node-a:2': 'local-role', 'node-a:3': 'local-role', 'node-a:4': 'waiting' })
  assert.equal(b.journal.versionVector()['node-a'], 3, 'the waiting subagent record holds the vector below it')
})

test('a member that has gone from the registry is not "no roles": held, not shipped', async () => {
  const a = node('node-a')
  const b = node('node-b')
  a.ports.sessionRoles = async () => ({ bound: true, member: 'contoso-1', roles: undefined })
  a.write('gone', 'Written by a member since removed.', 's-old')
  const r = await sync(a, b)
  assert.deepEqual(names(b), [])
  assert.equal(r.held[0]!.code, 'waiting')
})

test('a private place keeps its memories home by scope or by working dir, but never the home dir every role shares', async () => {
  const a = node('node-a')
  const b = node('node-b')
  a.unbound.add('s1')
  a.unbound.add('s2')
  a.kinds.set('s2', { cwd: '/home/u/contoso-guide/src' })
  a.write('by-scope', 'Polling stations list for the guide.', undefined, '-home-u-contoso-guide')
  a.write('by-cwd', 'Draft text for the guide.', 's2')
  a.write('home-scope', 'A note from the shared home scope.', 's1', '-home-u')
  const r = await sync(a, b)
  assert.deepEqual(names(b), ['home-scope'])
  assert.deepEqual(r.held.map((h) => h.code), ['local-place', 'local-place'])
})

test('a record from before sync classes goes by its shape: an old workflow is a pointer, an old decision is itself', async () => {
  const a = node('node-a')
  const b = node('node-b')
  const old = (slug: string, type: string) =>
    a.journal.appendMemory({ slug, source: `/m/${slug}.md`, scope: 'user', machine: 'node-a', authoredAt: 1, content: `---\nname: ${slug}\ndescription: ${slug} from before 6a\ntype: ${type}\n---\n\n${slug} body` })
  old('old-runbook', 'workflow')
  old('old-choice', 'decision')
  await sync(a, b)
  assert.deepEqual(b.mind.pointers().map((p) => p.slug), ['old-runbook'])
  assert.deepEqual(b.journal.replay().map((r) => r.slug), ['old-choice'])
})

test("a record the receiver's secret gate would refuse is held here, so it never costs the records beside it", async () => {
  const a = node('node-a')
  const b = node('node-b')
  a.write('before', 'A plain fact.')
  // Released from quarantine on this machine: in the journal, but secret-shaped.
  const planted = 'sk-ant-api03-PLANTEDsyntheticVALUE0123456789abcdef'
  a.journal.appendMemory({ slug: 'released', source: '/m/released.md', scope: 'user', machine: 'node-a', authoredAt: 1, content: `---\nname: released\n---\n\nkey ${planted}` })
  a.write('after', 'Another plain fact.')
  const r = await sync(a, b)
  assert.deepEqual(names(b), ['after', 'before'], 'the records beside it arrived')
  assert.deepEqual(r.held.map((h) => [h.record, h.code]), [['node-a:2', 'secret-gate']])
  assert.ok(!r.text.includes(planted))
  assert.equal(b.journal.versionVector()['node-a'], 3, 'a gap: the vector passes it')
  assert.deepEqual(a.mind.heldByCode(), { 'secret-gate': 1 }, 'listed for status')
  assert.deepEqual(a.mind.held(), [{ record: 'node-a:2', code: 'secret-gate', slug: 'released' }], 'by id and slug, never content')
})
