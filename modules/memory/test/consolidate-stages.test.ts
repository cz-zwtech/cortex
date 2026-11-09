import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

import { ContextStore } from '../server/context/store.js'
import { applyFacets, type FacetOp } from '../server/consolidate/facets.js'
import type { ModelCall } from '../server/consolidate/model.js'
import { consolidate, revert } from '../server/consolidate/run.js'
import { lessonCandidates, parseRelations } from '../server/consolidate/stages.js'
import { ingest } from '../server/ingest.js'
import { Journal } from '../server/journal.js'
import { MemoryStore } from '../server/store.js'
import type { Memory } from '../server/types.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const DAY = 86_400_000
const NOW = Date.parse('2026-10-27T12:00:00Z')

const rig = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-stages-'))
  dirs.push(dir)
  const db = new Database(':memory:')
  db.exec(schema)
  return { dir, store: new MemoryStore(db), journal: new Journal({ dir: path.join(dir, 'journal'), machine: 'node-a' }) }
}
type Rig = ReturnType<typeof rig>

const add = (r: Rig, slug: string, body: string, authoredAt = NOW - DAY): Memory => {
  ingest({ content: `---\nname: ${slug}\ndescription: ${body}\n---\n\n${body}\n`, body: `${body}\n`, slug, scope: 'user', source: `/m/${slug}.md`, machine: 'node-a', authoredAt }, r)
  return r.store.byName(slug)[0]!
}

/** File memories under facets directly, as an earlier facets stage would have. */
const file = (r: Rig, ops: [Memory, string][]) =>
  applyFacets('seed', ops.map(([m, concern]): FacetOp => ({ memory: m.id, focus: { type: 'concern', term: concern }, about: [] })), [], { ...r, machine: 'node-a', now: NOW })

/** A fake model that answers each stage's prompt by its own handler, and counts calls. */
const router = (h: { pairs?: (p: { a: { name: string }; b: { name: string } }[]) => object; merge?: () => object; lesson?: () => object; digest?: (s: { span: number; dialogue: string }[]) => object }) => {
  const calls: string[] = []
  const call: ModelCall = (prompt) => {
    let out: object = {}
    if (prompt.includes('Pairs: ') && h.pairs) {
      calls.push('relations')
      out = h.pairs(JSON.parse(prompt.slice(prompt.indexOf('Pairs: ') + 7)))
    } else if (prompt.includes('facet vocabulary') && h.merge) {
      calls.push('vocabulary')
      out = h.merge()
    } else if (prompt.includes('Stretches: ') && h.digest) {
      calls.push('digests')
      out = h.digest(JSON.parse(prompt.slice(prompt.indexOf('Stretches: ') + 11)))
    } else if (prompt.includes('repeated tool failures') && h.lesson) {
      calls.push('lessons')
      out = h.lesson()
    } else calls.push('other')
    return { text: JSON.stringify(out), tokens: 100, costUsd: 0.0001 }
  }
  return { call, calls }
}
const run = (r: Rig, call: ModelCall, stages: Parameters<typeof consolidate>[0]['stages'], extra: Partial<Parameters<typeof consolidate>[0]> = {}) =>
  consolidate({ store: r.store, journal: r.journal, machine: 'node-a', call, model: 'haiku', stages, now: () => NOW, ...extra })

test('relation answers are checked: unknown pairs, unknown relations, repeats and a contradiction without a newer side are rejected', () => {
  const pairs = [[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }, { id: 'd' }]] as unknown as [Memory, Memory][]
  const p = parseRelations(
    JSON.stringify({
      pairs: [
        { pair: 0, relation: 'contradicts', newer: 'b', why: 'changed course' },
        { pair: 0, relation: 'related' },
        { pair: 1, relation: 'contradicts' },
        { pair: 7, relation: 'related' },
        { pair: 1, relation: 'sort-of' },
      ],
    }),
    pairs,
  )
  assert.deepEqual(p.ops, [{ a: 'a', b: 'b', relation: 'contradicts', newer: 'b', why: 'changed course' }])
  assert.equal(p.rejected, 4)
  assert.equal(parseRelations('nope', pairs).rejected, 2)
})

test('relations: a contradiction flags the older memory, a duplicate links both, judged pairs are not asked again, and revert undoes all of it', () => {
  const r = rig()
  const old = add(r, 'queue-rabbit', 'The job queue is RabbitMQ.', NOW - 30 * DAY)
  const neu = add(r, 'queue-log', 'The job queue moved to the append-only log; RabbitMQ is gone.')
  const dup = add(r, 'queue-log-again', 'The job queue is the append-only log.')
  file(r, [[old, 'job-queue'], [neu, 'job-queue'], [dup, 'job-queue']])
  // A similarity edge from before the run must survive its revert.
  r.store.addDerivedEdge({ src: neu.id, dst: dup.id, rel: 'similar_to', score: 0.8 }, NOW)

  const answer = (ps: { a: { name: string }; b: { name: string } }[]) => ({
    pairs: ps.map((p, i) => {
      const names = [p.a.name, p.b.name].sort().join(' ')
      if (names === 'queue-log queue-rabbit') return { pair: i, relation: 'contradicts', newer: p.a.name === 'queue-log' ? 'a' : 'b', why: 'moved off RabbitMQ' }
      if (names === 'queue-log queue-log-again') return { pair: i, relation: 'duplicate', why: 'same fact' }
      return { pair: i, relation: 'none' }
    }),
  })
  const m = router({ pairs: answer })
  const rep = run(r, m.call, ['relations'])
  assert.equal(rep.status, 'done')
  assert.equal(rep.stages.relations, 3)
  assert.ok(r.store.derivedEdges(neu.id).some((e) => e.rel === 'contradicts' && e.dst === old.id), 'the newer contradicts the older')
  assert.deepEqual(r.store.flags(old.id).map((f) => f.reason), ['contradicted'])
  assert.equal(r.store.flags(neu.id).length, 0, 'the newer is current, not flagged')
  assert.equal(r.store.get(old.id)?.content.includes('RabbitMQ'), true, 'the older is kept, never rewritten')

  const again = router({ pairs: answer })
  assert.equal(run(r, again.call, ['relations']).status, 'nothing to do')
  assert.deepEqual(again.calls, [], 'every pair was judged once already')

  revert(rep.run, { ...r, machine: 'node-a' })
  assert.equal(r.store.flags(old.id).length, 0)
  assert.ok(!r.store.derivedEdges(neu.id).some((e) => e.rel === 'contradicts'))
  assert.ok(r.store.derivedEdges(neu.id).some((e) => e.rel === 'similar_to' && e.dst === dup.id), 'the earlier edge survives the revert')
  assert.equal(r.store.unjudgedPairs(10).length, 3, 'and the pairs are open again')
})

test('vocabulary: unused facets retire, a merge moves every edge to the kept term, and revert restores both', () => {
  const r = rig()
  const a = add(r, 'cache-ttl', 'Cache entries live for five minutes.')
  const b = add(r, 'cache-keys', 'Cache keys carry the tenant id.')
  const c = add(r, 'cache-warm', 'The cache is warmed at deploy.')
  file(r, [[a, 'caching'], [b, 'caching'], [c, 'caching-layer']])
  r.store.upsertHub({ id: 'facet:concern:orphan', kind: 'facet', name: 'concern:orphan' })

  const bad = { type: 'concern', from: 'caching-layer', into: 'not-a-term' }
  const m = router({ merge: () => ({ merge: [{ type: 'concern', from: 'caching-layer', into: 'caching' }, bad] }) })
  const rep = run(r, m.call, ['vocabulary'])
  assert.equal(rep.stages.vocabulary, 2, 'one retired, one merged')
  assert.equal(rep.rejected, 1)
  assert.equal(r.store.getHub('facet:concern:orphan'), null)
  assert.equal(r.store.getHub('facet:concern:caching-layer'), null)
  assert.deepEqual(r.store.derivedInto('facet:concern:caching').map((e) => e.src).sort(), [a.id, b.id, c.id].sort())

  const undone = revert(rep.run, { ...r, machine: 'node-a' })
  assert.ok(undone.restored >= 3)
  assert.ok(r.store.getHub('facet:concern:orphan'))
  assert.deepEqual(r.store.derivedInto('facet:concern:caching-layer').map((e) => e.src), [c.id])
  assert.deepEqual(r.store.derivedInto('facet:concern:caching').map((e) => e.src).sort(), [a.id, b.id].sort())
})

test('staleness: a passed end date and a long-unused old memory are flagged, recent ones are not', () => {
  const r = rig()
  const lapsed = add(r, 'freeze', 'Deploy freeze is in force until 2026-09-30.')
  const future = add(r, 'freeze-next', 'Deploy freeze is in force until 2027-01-15.')
  const old = add(r, 'old-port', 'The gateway listens on 7300.', NOW - 400 * DAY)
  const rep = run(r, router({}).call, ['staleness'])
  assert.equal(rep.batches, 0, 'no model needed')
  assert.deepEqual(r.store.flags(lapsed.id).map((f) => f.reason), ['condition-lapsed'])
  assert.deepEqual(r.store.flags(old.id).map((f) => f.reason), ['unconfirmed'])
  assert.equal(r.store.flags(future.id).length, 0)
  assert.equal(run(r, router({}).call, ['staleness']).stages.staleness, 0, 'a flag is raised once')
})

test('tool lessons: repeats across sessions become one derived memory, asked once, and a revert forgets it durably', () => {
  const r = rig()
  const ctx = new ContextStore(path.join(r.dir, 'context.sqlite'))
  const fail = (session: string, i: number) => {
    ctx.apply('node-a', session, { key: `f${i}`, uuid: `f${i}`, speaker: 'tool-note', at: NOW - DAY, text: 'Bash pkill -f watcher failed: exit 144' })
    ctx.apply('node-a', session, { key: `r${i}`, uuid: `r${i}`, speaker: 'assistant', at: NOW - DAY + 1, text: 'pkill matched its own shell; using the [w]atcher bracket pattern.' })
  }
  fail('s1', 1)
  fail('s2', 2)
  assert.equal(lessonCandidates(ctx.toolFailures(0)).length, 0, 'two sessions are not yet a lesson')
  fail('s3', 3)
  assert.equal(lessonCandidates(ctx.toolFailures(0)).length, 1)

  const lesson = { lesson: { name: 'pkill bracket pattern', rule: 'When pkill -f fails with 144, bracket the first letter so it cannot match its own shell.', why: 'pkill -f matched the invoking shell.' } }
  const m = router({ lesson: () => lesson })
  const rep = run(r, m.call, ['lessons'], { context: ctx })
  assert.equal(rep.stages.lessons, 1)
  const made = r.store.byName('tool-lesson-pkill-bracket-pattern')[0]!
  assert.equal(made.authorship, 'derived')
  assert.equal(made.shape, 'error')

  const again = router({ lesson: () => lesson })
  run(r, again.call, ['lessons'], { context: ctx })
  assert.deepEqual(again.calls, [], 'a failure group is judged once')

  revert(rep.run, { ...r, machine: 'node-a' })
  assert.equal(r.store.get(made.id), null)
  assert.ok([...r.journal.read()].some((x) => x.kind === 'tombstone'), 'tombstoned, so a rebuild does not bring it back')
  ctx.close()
})

test('stages share one batch budget and one daily cap', () => {
  const r = rig()
  const ms = Array.from({ length: 6 }, (_, i) => add(r, `note-${i}`, `Note ${i} on the shared topic.`))
  file(r, ms.map((m) => [m, 'shared-topic']))
  const m = router({ pairs: (ps) => ({ pairs: ps.map((_, i) => ({ pair: i, relation: 'related' })) }), merge: () => ({ merge: [] }) })
  const rep = run(r, m.call, ['relations', 'vocabulary'], { maxBatches: 1 })
  assert.equal(rep.batches, 1)
  assert.deepEqual(m.calls, ['relations'])
  assert.equal(run(r, router({}).call, ['relations'], { dailyTokenCap: 50 }).status, 'over the daily cap')
})

test('digests: only finished, cold, long enough spans are digested, cut at compactions; checked, searchable, reverted', () => {
  const r = rig()
  const a = add(r, 'cache-ttl', 'Cache entries live for five minutes.')
  file(r, [[a, 'caching']])
  const ctx = new ContextStore(path.join(r.dir, 'context.sqlite'))
  const say = (session: string, n: number, at: number, opts: { boundaryAt?: number; text?: string } = {}) => {
    for (let i = 1; i <= n; i++)
      ctx.apply('node-a', session, { key: `${session}-${i}`, uuid: `${session}-${i}`, speaker: i % 2 ? 'user' : 'assistant', at: at + i, text: `${opts.text ?? 'talk'} line ${i}`, ...(i === opts.boundaryAt ? { boundary: true } : {}) })
  }
  say('old', 10, NOW - 60 * DAY, { boundaryAt: 6, text: 'We chose a five minute cache TTL for the billing API' })
  say('warm', 6, NOW - 60 * DAY)
  say('recent', 6, NOW - 2 * DAY)
  say('tiny', 2, NOW - 60 * DAY)
  const warmBlock = ctx.search('talk', 50).find((b) => b.session === 'warm')!
  ctx.touchHeat([String(warmBlock.id)], 'block', 'used', NOW - DAY)

  const spans = ctx.coldSpans(10, NOW)
  assert.deepEqual(spans.map((sp) => [sp.session, sp.seq_from, sp.seq_to]), [['old', 1, 5], ['old', 6, 10]], 'cut at the compaction; warm, recent and tiny ones left')

  const planted = 'sk-ant-api03-PLANTEDsyntheticVALUE0123456789abcdef'
  const m = router({
    digest: (ss) => ({
      digests: [
        { span: 0, keywords: ['Cache TTL', 'billing-api'], facets: ['concern:caching', 'concern:not-in-vocab'], summary: 'Chose a five minute cache TTL for billing.' },
        { span: 1, keywords: ['oops'], summary: `The key was ${planted}.` },
      ].slice(0, ss.length),
    }),
  })
  const rep = run(r, m.call, ['digests'], { context: ctx })
  assert.equal(rep.stages.digests, 1)
  assert.equal(rep.rejected, 1, 'a secret-shaped digest is refused whole')
  const d = ctx.digest('node-a:old:1')!
  assert.deepEqual(d.keywords, ['cache-ttl', 'billing-api'])
  assert.deepEqual(d.facets, ['concern:caching'], 'facets only from the vocabulary')
  assert.equal(d.made_by, 'haiku')
  assert.equal(ctx.digest('node-a:old:6'), undefined)
  assert.equal(ctx.searchDigests('billing ttl')[0]?.span, 'node-a:old:1')
  assert.ok([...r.journal.read()].some((x) => x.kind === 'consolidation' && (x as { op?: string }).op === 'digest'), 'journaled, so it replicates')
  assert.deepEqual(ctx.coldSpans(10, NOW).map((sp) => sp.id), ['node-a:old:6'], 'a digested span is not asked again')

  const undone = revert(rep.run, { ...r, machine: 'node-a', context: ctx })
  assert.equal(undone.digests, 1)
  assert.equal(ctx.searchDigests('billing ttl').length, 0)
  ctx.close()
})
