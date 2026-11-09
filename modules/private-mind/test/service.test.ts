/**
 * The sync service over a fake comms bus (step 6c-2): rounds, requests,
 * pushes and acks between three nodes; central first, degraded mode when it is
 * away and the reconcile when it returns; bundles in parts, a lost part finished
 * by the next round. Every send must be home-only. The real transport over the
 * home mesh, with a gateway present, is the container sim (6d).
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
import { MindConfigSchema } from '../server/config.js'
import { MindService, type InboxItem, type MindState_ } from '../server/service.js'
import { makeBundle } from '../server/sync.js'
import { loadState } from '../server/state.js'
import { MindStore } from '../server/store.js'
import type { Ports } from '../server/sync.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'memory', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mindsvc-'))
  dirs.push(d)
  return d
}

/** A bus between in-process nodes: delivers to `<node>:mind`, copies attached files (the sender deletes its own), records how each was sent. */
const bus = () => {
  const inboxes = new Map<string, InboxItem[]>()
  const gossip = new Map<string, MindState_>()
  const reachable = new Set<string>()
  const sends: { from: string; to: string; homeOnly: boolean }[] = []
  let n = 0
  let dropNextFile = false
  const store = tmp()
  const port = (self: string) => ({
    send: async (from: string, to: string, body: string, opts: { files?: string[]; homeOnly: true }) => {
      const node = to.split(':')[0]!
      sends.push({ from, to, homeOnly: opts.homeOnly === true })
      if (!reachable.has(node)) return { ok: false, outcome: 'unreachable' }
      if (opts.files?.length && dropNextFile) {
        dropNextFile = false
        return { ok: true }
      }
      const files = (opts.files ?? []).map((f) => {
        const copy = path.join(store, `${++n}-${path.basename(f)}`)
        fs.copyFileSync(f, copy)
        return { name: path.basename(f), path: copy }
      })
      inboxes.set(node, [...(inboxes.get(node) ?? []), { id: `m${++n}`, from, body, node: self, ...(files.length ? { files } : {}) }])
      return { ok: true }
    },
    inbox: async () => [...(inboxes.get(self) ?? [])],
    markSeen: (_m: string, ids: string[]) => inboxes.set(self, (inboxes.get(self) ?? []).filter((i) => !ids.includes(i.id))),
    mindNodes: () => [...reachable],
  })
  return { inboxes, gossip, reachable, sends, port, dropFile: () => (dropNextFile = true) }
}
type Bus = ReturnType<typeof bus>

const node = (machine: string, b: Bus, partLines?: number) => {
  const dir = tmp()
  const db = new Database(':memory:')
  db.exec(schema)
  const store = new MemoryStore(db)
  const journal = new Journal({ dir: path.join(dir, 'journal'), machine })
  const context = new ContextStore(path.join(dir, 'context.sqlite'))
  const mindDir = path.join(dir, 'mind')
  const ports: Ports = {
    versionVector: () => journal.versionVector(),
    journalStream: (since) => [...journal.stream(since)] as never,
    journalAdopt: (records) => adoptRecords(records, { store, journal }),
    blockVector: () => context.blockVector(),
    blockStream: (since) => context.streamBlocks(since) as never,
    blockAdopt: (blocks) => context.adoptBlocks(blocks, machine),
    shapeOf: (c: string) => frontmatterOf(c).shape,
    sessionRoles: async () => ({ bound: false }),
  }
  const mind = new MindStore(mindDir)
  const svc: MindService = new MindService({
    self: machine,
    cfg: MindConfigSchema.parse({ enabled: true, central: 'node-b' }),
    dataDir: mindDir,
    store: mind,
    ports,
    comms: b.port(machine),
    peers: () => [...b.gossip.values()],
    publish: () => b.gossip.set(machine, svc.gossip()),
    log: () => {},
    ...(partLines ? { partLines } : {}),
  })
  b.reachable.add(machine)
  b.gossip.set(machine, svc.gossip())
  const write = (slug: string) => {
    const content = `---\nname: ${slug}\ndescription: ${slug} fact\ntype: decision\n---\n\n${slug} fact`
    ingest({ content, body: `${slug} fact`, slug, scope: 'user', source: `/m/${slug}.md`, machine, authoredAt: Date.now() }, { store, journal })
    b.gossip.set(machine, svc.gossip())
  }
  const writeWorking = (slug: string) => {
    const content = `---\nname: ${slug}\ndescription: ${slug} steps\ntype: thread\nsync: local\n---\n\n${slug} steps`
    ingest({ content, body: `${slug} steps`, slug, scope: 'user', source: `/m/${slug}.md`, machine, authoredAt: Date.now() }, { store, journal })
    b.gossip.set(machine, svc.gossip())
  }
  return { machine, svc, journal, store, mindDir, mind, ports, write, writeWorking, names: () => store.all().map((m) => m.name).sort() }
}

/** Let every node take in what has arrived until the bus is quiet. */
const settle = async (b: Bus, nodes: ReturnType<typeof node>[]) => {
  for (let i = 0; i < 10; i++) {
    let moved = 0
    for (const n of nodes) if (b.reachable.has(n.machine)) moved += await n.svc.drain()
    if (!moved) return
  }
}

test('a round pushes to central and pulls from it; a third node gets it all through central; nothing is sent but home-only', async () => {
  const b = bus()
  const a = node('node-a', b)
  const c = node('node-b', b)
  const d = node('node-c', b)
  a.write('queue-choice')
  a.write('cache-ttl')
  d.write('pool-size')
  assert.equal((await a.svc.round()).with, 'node-b')
  await settle(b, [a, c, d])
  assert.deepEqual(c.names(), ['cache-ttl', 'queue-choice'], 'central took the push')
  await d.svc.round()
  await settle(b, [a, c, d])
  assert.deepEqual(d.names(), ['cache-ttl', 'pool-size', 'queue-choice'], 'node-c has a\'s memories through central')
  await a.svc.round()
  await settle(b, [a, c, d])
  assert.deepEqual(a.names(), ['cache-ttl', 'pool-size', 'queue-choice'], 'and a has c\'s')
  const s = loadState(a.mindDir)
  assert.equal(s.base, loadState(c.mindDir).commits[0]!.id, 'a is built on central\'s latest commit')
  assert.equal(s.degraded, false)
  assert.ok(b.sends.length > 0 && b.sends.every((x) => x.homeOnly), 'every send home-only')
})

test('central away: sync from the peer built on the newest central commit, marked degraded; central back: reconcile and clear', async () => {
  const b = bus()
  const a = node('node-a', b)
  const c = node('node-b', b)
  const d = node('node-c', b)
  a.write('one')
  await a.svc.round()
  await settle(b, [a, c, d])
  await a.svc.round()
  await settle(b, [a, c, d])
  b.reachable.delete('node-b')
  a.write('while-central-away')
  const r = await d.svc.round()
  assert.deepEqual([r.with, r.degraded], ['node-a', true])
  await settle(b, [a, c, d])
  assert.deepEqual(d.names(), ['one', 'while-central-away'], 'capture never stopped, and the peer served it')
  assert.equal(loadState(d.mindDir).degraded, true)

  b.reachable.add('node-b')
  const back = await d.svc.round()
  assert.deepEqual([back.with, back.degraded], ['node-b', false])
  await settle(b, [a, c, d])
  assert.ok(c.names().includes('while-central-away'), 'central got what happened while it was away')
  assert.equal(loadState(d.mindDir).degraded, false, 'reconciled with central: no longer degraded')
})

test('a bundle in parts: a lost part is simply finished by the next round, with nothing doubled', async () => {
  const b = bus()
  const a = node('node-a', b, 2)
  const c = node('node-b', b, 2)
  for (const s of ['p1', 'p2', 'p3', 'p4', 'p5']) a.write(s)
  b.dropFile()
  await a.svc.round()
  await settle(b, [a, c])
  assert.ok(c.names().length < 5, 'one part never arrived')
  await a.svc.round()
  await settle(b, [a, c])
  assert.deepEqual(c.names(), ['p1', 'p2', 'p3', 'p4', 'p5'])
  assert.equal(c.journal.replay().length, 5, 'each once')
})

test('nobody reachable: the round says so and waits; a disabled node never syncs', async () => {
  const b = bus()
  const a = node('node-a', b)
  b.reachable.clear()
  b.reachable.add('node-a')
  assert.equal((await a.svc.round()).with, undefined)
  assert.equal(b.sends.length, 0)
})

test('a rebuilt node that reuses an old id is refused before it sends; with a new id it recovers everything from central', async () => {
  const b = bus()
  const a = node('node-a', b)
  const c = node('node-b', b)
  a.write('queue-choice')
  a.write('cache-ttl')
  await a.svc.round()
  await settle(b, [a, c])
  assert.deepEqual(c.names(), ['cache-ttl', 'queue-choice'])

  const reused = node('node-a', b) // the box died; its old machine-id file was copied onto the new one
  const sent = b.sends.length
  const r = await reused.svc.round()
  assert.equal(r.with, undefined)
  assert.match(r.refused ?? '', /node-b holds records of node-a up to 2, this journal only to 0/)
  assert.equal(b.sends.length, sent, 'nothing pushed, nothing requested')
  assert.match(reused.svc.refused ?? '', /new machine id/, 'and the status can say so')
  reused.write('pool-size')
  assert.equal((await reused.svc.round()).with, undefined, 'still refused after it writes')

  const fresh = node('node-d', b)
  assert.equal((await fresh.svc.round()).with, 'node-b')
  await settle(b, [fresh, c])
  assert.deepEqual(fresh.names(), ['cache-ttl', 'queue-choice'], 'a new id gets everything from central')
})

test('syncOnce: one round, then take what comes back until quiet; a second write goes on the next run', async () => {
  const b = bus()
  const a = node('node-a', b)
  const c = node('node-b', b)
  c.write('pool-size')
  a.write('queue-choice')
  const between = async () => {
    await c.svc.drain() // central, running on its own host
    await new Promise((r) => setTimeout(r, 5))
  }
  const r = await a.svc.syncOnce({ quietMs: 40, capMs: 5_000, sleep: between })
  assert.equal(r.with, 'node-b')
  assert.ok(r.took > 0, 'it took central\'s answer before exiting')
  assert.deepEqual(a.names(), ['pool-size', 'queue-choice'])
  assert.deepEqual(c.names(), ['pool-size', 'queue-choice'])

  a.write('cache-ttl')
  await a.svc.syncOnce({ quietMs: 40, capMs: 5_000, sleep: between })
  assert.deepEqual(c.names(), ['cache-ttl', 'pool-size', 'queue-choice'])

  const reused = node('node-a', b)
  const refused = await reused.svc.syncOnce({ quietMs: 40, capMs: 5_000, sleep: between })
  assert.match(refused.refused ?? '', /holds records of node-a/, 'the id guard holds in a one-shot too')
  assert.equal(refused.took, 0)
})

test('syncOnce stops at its cap even while messages keep coming', async () => {
  const b = bus()
  const a = node('node-a', b)
  node('node-b', b)
  let n = 0
  const started = Date.now()
  const r = await a.svc.syncOnce({
    quietMs: 1_000,
    capMs: 120,
    sleep: async () => {
      b.inboxes.set('node-a', [...(b.inboxes.get('node-a') ?? []), { id: `noise${++n}`, from: 'node-b:mind', body: '{"t":"unknown"}', node: 'node-a' }])
      await new Promise((res) => setTimeout(res, 10))
    },
  })
  assert.equal(r.with, 'node-b')
  assert.ok(Date.now() - started < 1_000, 'capped, not waiting for quiet')
})

test('syncOnce waits for central to become reachable (the mesh daemon starts with the same session hook)', async () => {
  const b = bus()
  const a = node('node-a', b)
  const c = node('node-b', b)
  a.write('queue-choice')
  b.reachable.delete('node-b')
  let waits = 0
  const r = await a.svc.syncOnce({
    quietMs: 40,
    capMs: 5_000,
    sourceWaitMs: 5_000,
    sleep: async () => {
      if (++waits === 3) b.reachable.add('node-b')
      await c.svc.drain()
      await new Promise((res) => setTimeout(res, 5))
    },
  })
  assert.equal(r.with, 'node-b')
  assert.deepEqual(c.names(), ['queue-choice'])

  b.reachable.delete('node-b')
  const none = await a.svc.syncOnce({ quietMs: 40, capMs: 5_000, sourceWaitMs: 60, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 10))) })
  assert.equal(none.with, undefined, 'still nobody after the wait: it gives up and exits')
})

test('a node gossips its vectors after every round, so peers can pick it as a source while central is away', async () => {
  const b = bus()
  const a = node('node-a', b)
  node('node-b', b)
  a.write('queue-choice')
  a.write('cache-ttl')
  b.gossip.set('node-a', { ...b.gossip.get('node-a')!, vv: {} }) // as gossiped at start, before any write
  await a.svc.round()
  assert.equal(b.gossip.get('node-a')?.vv['node-a'], 2)
})

test('a bundle never carries a pointer back to the node that owns it', async () => {
  const b = bus()
  const a = node('node-a', b)
  const c = node('node-b', b)
  a.writeWorking('deploy-steps')
  await a.svc.round()
  await settle(b, [a, c])
  assert.ok(c.mind.pointers().some((p) => p.owner.node === 'node-a'), 'central holds a\'s pointer')
  const cfg = MindConfigSchema.parse({ enabled: true, central: 'node-b' })
  const pointersFor = async (to: string) =>
    (await makeBundle({ ports: c.ports, store: c.mind, cfg, self: 'node-b', since: { vv: {}, bvv: {} }, to })).lines.filter((l) => l.t === 'pointer')
  assert.equal((await pointersFor('node-a')).length, 0, 'not back to its owner')
  assert.equal((await pointersFor('node-c')).length, 1, 'still to a third node')
})
