import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

import { parseFacets } from '../server/consolidate/facets.js'
import { headlessEnv, type ModelCall } from '../server/consolidate/model.js'
import { consolidate, revert } from '../server/consolidate/run.js'
import { ingest } from '../server/ingest.js'
import { Journal } from '../server/journal.js'
import { recall } from '../server/recall.js'
import { lexicalSeed } from '../server/seed.js'
import { MemoryStore } from '../server/store.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const rig = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-consolidate-'))
  dirs.push(dir)
  const db = new Database(':memory:')
  db.exec(schema)
  return { store: new MemoryStore(db), journal: new Journal({ dir: path.join(dir, 'journal'), machine: 'node-a' }) }
}
const add = (r: ReturnType<typeof rig>, slug: string, body: string) =>
  ingest({ content: `---\nname: ${slug}\ndescription: ${body}\n---\n\n${body}\n`, body: `${body}\n`, slug, scope: 'user', source: `/m/${slug}.md`, machine: 'node-a', authoredAt: 1 }, r)

/** A fake model: answers from a table keyed by memory name, and records what it was shown. */
const fakeModel = (answer: (ids: { id: string; name: string }[], prompt: string) => object, seen: string[] = []): ModelCall => (prompt) => {
  seen.push(prompt)
  if (!prompt.includes('Memories: ')) return { text: '{}', tokens: 1000, costUsd: 0.001 }
  const items = JSON.parse(prompt.slice(prompt.indexOf('Memories: ') + 'Memories: '.length)) as { id: string; name: string }[]
  return { text: `Here you go:\n${JSON.stringify(answer(items, prompt))}`, tokens: 1000, costUsd: 0.001 }
}

const byName: Record<string, object> = {
  'queue-choice': { focus: { type: 'concern', term: 'Inter Service Communication' }, about: [{ type: 'work', term: 'billing-api' }, { type: 'layer', term: 'technique' }] },
  'cache-ttl': { focus: { type: 'concern', term: 'caching' }, about: [{ type: 'work', term: 'billing-api' }] },
  'webhook-retries': { focus: { type: 'concern', term: 'inter-service-communication' }, about: [{ type: 'work', term: 'payments' }] },
}
const answer = (items: { id: string; name: string }[]) => ({
  memories: items.map((i) => ({ id: i.id, ...(byName[i.name] ?? { focus: { type: 'subject', term: 'misc' } }) })),
  spine: [{ child: 'billing-api', parent: 'payments' }],
})

test('every operation is checked: unknown ids, bad types and bad terms are rejected, terms are normalised', () => {
  const batch = [{ id: 'm1' }, { id: 'm2' }] as never
  const p = parseFacets(
    JSON.stringify({
      memories: [
        { id: 'm1', focus: { type: 'concern', term: 'Data Ownership!' }, about: [{ type: 'bogus', term: 'x' }, { type: 'work', term: 'Billing API' }] },
        { id: 'zz', focus: { type: 'concern', term: 'x' } },
        { id: 'm2', focus: { type: 'nope', term: 'x' } },
      ],
      spine: [{ child: 'a', parent: 'a' }],
    }),
    batch,
  )
  assert.deepEqual(p.ops, [{ memory: 'm1', focus: { type: 'concern', term: 'data-ownership' }, about: [{ type: 'work', term: 'billing-api' }] }])
  assert.equal(p.rejected, 3)
  assert.equal(parseFacets('not json at all', batch).rejected, 2)
})

test('a run applies facets and the spine, journals them, reuses the vocabulary, and reverts whole', () => {
  const r = rig()
  add(r, 'queue-choice', 'The job queue is the append-only log, not RabbitMQ.')
  add(r, 'cache-ttl', 'Cache entries live for five minutes.')
  const seen: string[] = []
  const rep = consolidate({ ...r, machine: 'node-a', call: fakeModel(answer, seen), model: 'haiku' })
  assert.equal(rep.status, 'done')
  assert.equal(rep.remaining, 0)
  const q = r.store.byName('queue-choice')[0]!
  assert.deepEqual(r.store.derivedEdges(q.id).map((e) => `${e.rel} ${e.dst}`).sort(), ['about facet:layer:technique', 'about facet:work:billing-api', 'focus facet:concern:inter-service-communication'])
  assert.ok(r.store.derivedEdges('facet:work:billing-api').some((e) => e.rel === 'part_of' && e.dst === 'facet:work:payments'), 'the spine')
  assert.ok(r.journal.read !== undefined && [...r.journal.read()].some((x) => x.kind === 'consolidation'), 'journaled')

  add(r, 'webhook-retries', 'Webhooks retry with backoff.')
  consolidate({ ...r, machine: 'node-a', call: fakeModel(answer, seen), model: 'haiku' })
  assert.match(seen.at(-1)!, /inter-service-communication/, 'the existing vocabulary is offered for reuse')

  const run = r.store.runs()[1]!.run
  const undone = revert(run, { ...r, machine: 'node-a' })
  assert.ok(undone.edges >= 5)
  assert.equal(r.store.derivedEdges(q.id).length, 0, 'the reverted run left nothing')
  assert.equal(r.store.withoutFacets(10).length, 2, 'and its memories are back in the queue')
  assert.equal(r.store.runs()[1]!.status, 'reverted')
})

test('a dry run applies nothing; the daily cap and model errors stop a run and are reported', () => {
  const r = rig()
  for (let i = 0; i < 5; i++) add(r, `note-${i}`, `A note about topic number ${i} for the cap test.`)
  const dry = consolidate({ ...r, machine: 'node-a', call: fakeModel(answer), model: 'haiku', dryRun: true, batchSize: 2 })
  assert.equal(dry.ops, 8, '5 facet assignments and a spine link proposed per batch')
  assert.equal(r.store.withoutFacets(10).length, 5)
  assert.equal(r.store.runs().length, 0)

  const capped = consolidate({ ...r, machine: 'node-a', call: fakeModel(answer), model: 'haiku', batchSize: 2, dailyTokenCap: 1500 })
  assert.equal(capped.status, 'partial')
  assert.equal(capped.batches, 2, 'the cap stops the run between batches')
  assert.equal(consolidate({ ...r, machine: 'node-a', call: fakeModel(answer), model: 'haiku', dailyTokenCap: 1500 }).status, 'over the daily cap')

  const failing: ModelCall = () => ({ text: '', tokens: 0, costUsd: 0, error: 'claude exited 1' })
  assert.equal(consolidate({ ...r, machine: 'node-a', call: failing, model: 'haiku' }).status, 'failed')
})

test('a query by concern finds the memories filed under it, from any project, though their text never says it', () => {
  const r = rig()
  add(r, 'queue-choice', 'The job queue is the append-only log, not RabbitMQ.')
  add(r, 'webhook-retries', 'Webhooks retry with exponential backoff and jitter.')
  add(r, 'cache-ttl', 'Cache entries live for five minutes.')
  const ask = () => recall('what have we used for inter-service communication', { store: r.store, seeds: [lexicalSeed(r.store)], asOf: Date.now(), k: 5 }).hits.map((h) => h.memory.name)
  assert.deepEqual(ask(), [], 'before consolidation nothing says it')
  consolidate({ ...r, machine: 'node-a', call: fakeModel(answer), model: 'haiku' })
  const hits = ask()
  assert.deepEqual(hits.slice(0, 2).sort(), ['queue-choice', 'webhook-retries'], 'both first, from two different works')
  assert.ok(!hits.includes('cache-ttl') || hits.indexOf('cache-ttl') > 1, 'the cache note, if at all, only below them (it shares a work, not the concern)')
})

test("the headless model call never inherits the caller's Cortex overrides (27 Oct)", () => {
  const env = headlessEnv({ PATH: '/bin', HOME: '/home/x', CKN_STATE_DIR: '/tmp/s', CKN_MODULES_DIR: '/dev/m', CKN_MEMORY_DIRS: '/tmp/m', CORTEX_UNDER_TEST: '1' })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/x', CKN_WATCHER_NUDGE: 'off', CKN_AUTO_SNAPSHOT: 'off' })
})
