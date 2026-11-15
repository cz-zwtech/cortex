/**
 * Retire (memory update-retire design, sections 2 and 3, and the recall-side
 * collapse): out of recall, session context, standing, rules and list, kept, and
 * not brought back by its own old text from any machine.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

import { adoptRecords, ingest } from '../server/ingest.js'
import { Journal } from '../server/journal.js'
import { recall } from '../server/recall.js'
import { applyDuplicates, planDuplicates, resolveMemory, retire, unretire } from '../server/retire.js'
import { lexicalSeed } from '../server/seed.js'
import { buildSessionContext } from '../server/sessionContext.js'
import { MemoryStore } from '../server/store.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const node = (machine: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-retire-'))
  dirs.push(root)
  const db = new Database(':memory:')
  db.exec(schema)
  return { machine, store: new MemoryStore(db), journal: new Journal({ dir: path.join(root, 'journal'), machine }) }
}
type Node = ReturnType<typeof node>

let clock = 1_000_000
const write = (n: Node, name: string, body: string, opts: { file?: string; head?: string; authoredAt?: number } = {}) => {
  const content = `---\nname: ${name}\ndescription: ${body.slice(0, 40)}\n${opts.head ?? 'type: feedback\n'}---\n\n${body}\n`
  const r = ingest({ content, body, slug: name, scope: 'user', source: `/memory/${opts.file ?? name}.md`, machine: n.machine, authoredAt: opts.authoredAt ?? (clock += 1000) }, n)
  return r.status === 'ingested' ? r.receipt.id : assert.fail('ingested')
}
const sync = (from: Node, to: Node) => adoptRecords([...from.journal.stream(to.journal.versionVector())], to)
const recalled = (n: Node, q: string) => recall(q, { store: n.store, seeds: [lexicalSeed(n.store)], asOf: Date.now() }).hits.map((h) => h.memory.id)
const live = (n: Node, name: string) => n.store.byName(name).filter((m) => m.retiredAt === undefined)

const GLACIER = 'Archive the quarterly ledger exports to the glacier bucket and keep them for seven years before deletion.'
const GLACIER_2 = 'Archive the quarterly ledger exports to the glacier bucket, encrypted, and keep them for ten years before deletion.'
const GLACIER_3 = 'Ledger exports now go to the cold storage tier of the main bucket; the glacier bucket is closed.'
/** Unrelated to GLACIER by word overlap, so from another file it links rather than updates. */
const DASHBOARD = 'The glacier ledger dashboard shows storage cost per team; finance reviews it on the first Monday of every month.'

test('a retired memory leaves recall, session context, standing, rules and list; list --all and show still have it; unretire restores it', () => {
  const n = node('node-a')
  const id = write(n, 'ledger-archive', GLACIER, { head: 'type: feedback\nstanding: true\n' })
  const rule = write(n, 'no-glacier-deletes', 'Never delete from the glacier bucket by hand.', {
    head: 'kind: rule\ncategory: ops\nwhy: deletions there are permanent\nscope: user\nvalid: always\nwhen: always\ndo: never delete from the glacier bucket by hand\nenforce: remind\n',
  })
  const ctx = () => buildSessionContext({ store: n.store, asOf: Date.now() })
  assert.ok(recalled(n, 'glacier ledger').includes(id))
  assert.ok(ctx().included.includes(id))

  retire(n, id, { by: 'tester@node-a', why: 'moved to cold storage' })
  retire(n, rule, { by: 'tester@node-a' })

  assert.ok(!recalled(n, 'glacier ledger').includes(id), 'not recalled')
  assert.ok(!ctx().included.includes(id), 'not in session context')
  assert.ok(!n.store.standing().some((m) => m.id === id), 'not standing')
  assert.ok(!n.store.rules().some((r) => r.id === rule), 'its rule stops applying')
  assert.ok(!n.store.search('', 10).some((m) => m.id === id), 'not listed')
  assert.ok(n.store.search('', 10, { retired: true }).some((m) => m.id === id), 'listed with --all')
  const shown = n.store.get(id)!
  assert.equal(shown.retiredBy, 'tester@node-a')
  assert.equal(shown.retireWhy, 'moved to cold storage')

  unretire(n, id, { by: 'tester@node-a' })
  assert.ok(recalled(n, 'glacier ledger').includes(id), 'back in recall')
  assert.equal(n.store.get(id)!.retiredAt, undefined)
})

test('retire by name refuses a name that is not unique, and lists the ids', () => {
  const n = node('node-a')
  const a = write(n, 'ledger-archive', GLACIER, { file: 'one' })
  const b = write(n, 'ledger-archive', GLACIER_3, { file: 'two' })
  const r = resolveMemory(n.store, 'ledger-archive', false)
  assert.ok('error' in r)
  assert.match(r.error, new RegExp(`${a}[\\s\\S]*${b}|${b}[\\s\\S]*${a}`))
  retire(n, a, { by: 't' })
  const unique = resolveMemory(n.store, 'ledger-archive', false)
  assert.ok('memory' in unique && unique.memory.id === b, 'unique among live rows')
})

test('across two nodes: the peer keeps it retired, old text does not revive it, and a new version clears it everywhere', () => {
  const a = node('node-a')
  const b = node('node-b')
  const id = write(a, 'ledger-archive', GLACIER)
  assert.equal(write(a, 'ledger-archive', GLACIER_2), id, 'a same-file update')
  retire(a, id, { by: 'tester@node-a' })
  sync(a, b)

  assert.equal(live(b, 'ledger-archive').length, 0, 'retired on the peer, both versions')
  write(b, 'ledger-archive', GLACIER, { file: 'old-copy' })
  assert.equal(live(b, 'ledger-archive').length, 0, 'a peer re-sweeping the old text gets a retired row')

  write(a, 'ledger-archive', GLACIER)
  assert.notEqual(a.store.get(id)!.retiredAt, undefined, 'old text written again stays retired')
  write(a, 'ledger-archive', GLACIER_3)
  assert.equal(a.store.get(id)!.retiredAt, undefined, 'a new version is live')
  sync(a, b)
  assert.deepEqual(live(b, 'ledger-archive').map((m) => m.content), [GLACIER_3], 'and live on the peer')

  write(b, 'ledger-archive', GLACIER, { file: 'old-copy' })
  write(a, 'ledger-archive', GLACIER, { authoredAt: 1 })
  sync(a, b)
  for (const n of [a, b]) assert.deepEqual(live(n, 'ledger-archive').map((m) => m.content), [GLACIER_3], `an older version does not replace the live row (${n.machine})`)
  assert.ok(a.store.get(id)!.retiredAt === undefined)
})

test('recall shows one of two live rows with the same name and scope: the newest', () => {
  const n = node('node-a')
  const older = write(n, 'ledger-archive', GLACIER, { file: 'one' })
  const newer = write(n, 'ledger-archive', DASHBOARD, { file: 'two' })
  assert.notEqual(newer, older)
  const hits = recalled(n, 'glacier ledger')
  assert.ok(hits.includes(newer))
  assert.ok(!hits.includes(older))
})

test('two facts under one name are each recalled by their own words', () => {
  const n = node('node-a')
  const older = write(n, 'ledger-archive', GLACIER, { file: 'one' })
  const newer = write(n, 'ledger-archive', 'The office printer on the third floor needs the blue driver.', { file: 'two' })
  assert.notEqual(newer, older)
  // The other row may follow by its concurrent_with edge; the one that matches leads.
  assert.equal(recalled(n, 'glacier')[0], older)
  assert.equal(recalled(n, 'printer')[0], newer)
})

test('duplicates: a group is found; apply retires all but the newest, or the kept row, superseded by it', () => {
  const n = node('node-a')
  const ids = [GLACIER, DASHBOARD, GLACIER_3].map((t, i) => write(n, 'ledger-archive', t, { file: `copy-${i}` }))
  write(n, 'unrelated-note', 'The printer on the third floor needs the blue driver.')
  const plan = planDuplicates(n.store)
  assert.equal(plan.length, 1)
  assert.deepEqual(plan[0]!.kept.map((m) => m.id), [ids[2]])

  assert.equal(applyDuplicates(n, plan, { by: 't' }), 2)
  for (const id of ids.slice(0, 2)) {
    assert.equal(n.store.get(id)!.supersededBy, ids[2])
    assert.ok(n.store.declaredEdges(id).some((e) => e.rel === 'evolved_into' && e.dst === ids[2]))
  }
  assert.equal(planDuplicates(n.store).length, 0)

  const m = node('node-a')
  const kept = [GLACIER, DASHBOARD, GLACIER_3].map((t, i) => write(m, 'ledger-archive', t, { file: `copy-${i}` }))
  applyDuplicates(m, planDuplicates(m.store, [kept[0]!]), { by: 't' })
  assert.deepEqual(live(m, 'ledger-archive').map((x) => x.id), [kept[0]])
  assert.equal(m.store.get(kept[2]!)!.supersededBy, kept[0])
})
