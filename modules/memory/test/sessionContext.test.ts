import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

import { MemoryStore, hashContent } from '../server/store.js'
import { buildSessionContext } from '../server/sessionContext.js'
import type { Memory, Shape } from '../server/types.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const NOW = 1_800_000_000_000

const store = () => {
  const db = new Database(':memory:')
  db.exec(schema)
  return new MemoryStore(db)
}

const add = (s: MemoryStore, id: string, content: string, over: Partial<Memory> = {}): Memory => {
  s.upsert({
    id,
    source: `/mem/${id}.md`,
    name: id,
    description: '',
    content,
    shape: 'feedback' as Shape, // standing, so the start set may draw it
    authorship: 'authored',
    scope: 'user',
    pinned: false,
    protected: false,
    machine: 'node-a',
    authoredAt: NOW - 1000,
    ingestedAt: NOW - 1000,
    outcome: '',
    outcomeText: '',
    contentHash: hashContent(id, '', content),
    ...over,
  } as never)
  return s.get(id) as Memory
}

const body = (n: number) => `fact number ${n} recorded with enough distinct words to be judged ${n}`

test('AN EMPTY GRAPH INJECTS NOTHING and says which state that is', () => {
  const s = store()
  const out = buildSessionContext({ store: s, asOf: NOW })
  assert.equal(out.corpusEmpty, true)
  assert.equal(out.text, '')
})

test('a populated graph is NOT corpusEmpty even if nothing fits', () => {
  const s = store()
  add(s, 'a', body(1))
  const out = buildSessionContext({ store: s, asOf: NOW, budgetBytes: 1 })
  assert.equal(out.corpusEmpty, false)
  assert.equal(out.droppedForBudget, 1, 'ranked, then did not fit')
})

test('THE BUDGET IS BYTES, NOT k: ten short memories may beat two long ones', () => {
  // A k-based cut cannot see length, and the constraint here is literally the
  // context window.
  const s = store()
  for (let i = 0; i < 10; i++) add(s, `short${i}`, body(i))
  add(s, 'long', 'x'.repeat(3_000))

  const out = buildSessionContext({ store: s, asOf: NOW, budgetBytes: 1_200 })
  assert.ok(!out.included.includes('long'), 'the long one did not fit')
  assert.ok(out.included.length > 1, 'several short ones did')
  assert.ok(out.bytes <= 1_200)
})

test('WHOLE BLOCKS ONLY: half a memory reads as complete', () => {
  const s = store()
  add(s, 'a', 'y'.repeat(500))
  const out = buildSessionContext({ store: s, asOf: NOW, budgetBytes: 100 })
  assert.equal(out.text, '')
  assert.equal(out.droppedForBudget, 1)
})

test('WHAT DID NOT FIT IS REPORTED: 294 cut must not look like 294 missing', () => {
  const s = store()
  for (let i = 0; i < 30; i++) add(s, `m${i}`, body(i))
  const out = buildSessionContext({ store: s, asOf: NOW, budgetBytes: 400 })
  assert.ok(out.droppedForBudget > 0)
  assert.equal(out.included.length + out.droppedForBudget, 30)
})

test('NO QUERY MEANS NO SIMILARITY: absent, never zero', () => {
  // Zero would mean "maximally dissimilar" and penalise every memory equally for
  // a question nobody asked. Absent means the signal has nothing to say, which
  // is exactly true at SessionStart.
  const s = store()
  add(s, 'a', body(1))
  const out = buildSessionContext({ store: s, asOf: NOW })
  assert.ok(out.text.includes('a'))
})

test('a PINNED memory is preferred over a plain one', () => {
  const s = store()
  add(s, 'plain', body(1))
  add(s, 'pinned', body(2), { pinned: true })
  const out = buildSessionContext({ store: s, asOf: NOW, budgetBytes: 200 })
  assert.equal(out.included[0], 'pinned')
})

test('SCOPE IS A PRIOR HERE TOO: other scopes are drawn in, merely ranked lower', () => {
  // Drawing only from the active scope would make this per-folder notebooks,
  // which is the thing the prior exists to prevent.
  const s = store()
  add(s, 'mine', body(1), { scope: 'proj-a' })
  add(s, 'wide', body(2), { scope: 'user' })
  const out = buildSessionContext({ store: s, scope: 'proj-a', asOf: NOW })
  assert.ok(out.included.includes('wide'), 'the user-wide memory is present')
  assert.equal(out.included[0], 'mine', 'and the in-scope one leads')
})

test('COLLAPSE HAPPENS BEFORE THE BUDGET: variants must not spend it twice', () => {
  const s = store()
  const shared = 'the deployment runs the release script and waits for a green health check'
  add(s, 'v1', shared)
  add(s, 'v2', shared + ' .')
  add(s, 'other', 'an entirely separate fact about invoicing cycles and monthly billing runs')

  const out = buildSessionContext({ store: s, asOf: NOW, budgetBytes: 10_000 })
  assert.ok(out.included.includes('other'), 'the different fact survived')
  assert.ok(
    !(out.included.includes('v1') && out.included.includes('v2')),
    'both variants must not both be injected',
  )
})

test('asOf is explicit: a stale memory sinks as time passes', () => {
  const s = store()
  add(s, 'old', body(1), { authoredAt: NOW - 400 * 24 * 3600_000 })
  add(s, 'fresh', body(2), { authoredAt: NOW })
  const out = buildSessionContext({ store: s, asOf: NOW, budgetBytes: 200 })
  assert.equal(out.included[0], 'fresh')
})

test('ONLY STANDING MEMORIES START A SESSION: an ops note waits to be asked about', () => {
  // Laptop Stage A: with every memory one shape, the start set was whichever
  // ops notes were most recent. Pinned, feedback and threads apply to every
  // session; the rest is recall's job.
  const s = store()
  add(s, 'ops', body(1), { shape: 'reference' as Shape })
  add(s, 'note', body(2), { shape: 'observation' as Shape })
  add(s, 'rule', body(3), { shape: 'feedback' as Shape })
  add(s, 'open', body(4), { shape: 'thread' as Shape })
  add(s, 'pin', body(5), { shape: 'observation' as Shape, pinned: true })

  const ctx = buildSessionContext({ store: s, asOf: Date.now() })

  assert.deepEqual([...ctx.included].sort(), ['open', 'pin', 'rule'])
})

test('STANDING RULES load first, all of them, ahead of 300 ranked feedback memories; never twice', () => {
  const s = store()
  for (let i = 0; i < 300; i++) add(s, `fb-${i}`, body(i))
  for (const r of ['no-todo', 'cite-only', 'relay-without-embellishing']) add(s, r, `rule ${r} applies to every session`, { pinned: true })
  const ctx = buildSessionContext({ store: s, asOf: NOW })
  const head = ctx.text.split('\n')[0]!
  assert.match(head, /^## Cortex: standing rules \(loaded in every session\)$/)
  for (const r of ['no-todo', 'cite-only', 'relay-without-embellishing']) {
    assert.ok(ctx.included.includes(r), r)
    assert.equal(ctx.text.split(`rule ${r} applies`).length - 1, 1, `${r} appears once`)
  }
  assert.ok(ctx.text.indexOf('rule cite-only') < ctx.text.indexOf('memories for this session'), 'rules before the ranked picks')
  assert.equal(ctx.standingDropped, 0)
})

test('standing rules over their own budget say so in the text, never silently', () => {
  const s = store()
  for (let i = 0; i < 40; i++) add(s, `rule-${i}`, `standing rule ${i} `.repeat(30), { pinned: true })
  const ctx = buildSessionContext({ store: s, asOf: NOW, standingBudgetBytes: 1_000 })
  assert.ok(ctx.standingDropped > 0)
  assert.match(ctx.text, new RegExp(`\\(${ctx.standingDropped} more standing rule\\(s\\) did not fit; list them all with: cortex-memory standing list\\)`))
})

test('39 STANDING RULES ALL LOAD, one line each, name and description, never the body', () => {
  const s = store()
  const desc = (i: number) => `Rule ${i}: ${'always state the reason and the scope before acting on it '.repeat(3)}`.slice(0, 150)
  for (let i = 0; i < 39; i++) add(s, `rule-${i}`, `BODY-${i} `.repeat(200), { pinned: true, description: desc(i) })
  const ctx = buildSessionContext({ store: s, asOf: NOW })
  assert.equal(ctx.standingDropped, 0)
  for (let i = 0; i < 39; i++) {
    assert.ok(ctx.text.includes(`- **rule-${i}**: ${desc(i)}`), `rule-${i} on one line`)
    assert.ok(!ctx.text.includes(`BODY-${i} `), `rule-${i} body left out`)
  }
  assert.match(ctx.text, /cortex-memory show <name>/)
  assert.doesNotMatch(ctx.text, /did not fit/)
})

test('a long standing set shortens every rule before it drops any; no description falls back to the first line', () => {
  const s = store()
  for (let i = 0; i < 39; i++) add(s, `rule-${i}`, 'x', { pinned: true, description: `rule ${i} `.repeat(40) })
  add(s, 'bare', '\n\nfirst line of the body\nsecond line', { pinned: true })
  const ctx = buildSessionContext({ store: s, asOf: NOW })
  assert.equal(ctx.standingDropped, 0)
  assert.ok(ctx.text.includes('- **bare**: first line of the body\n'))
  assert.ok(!ctx.text.includes('second line'))
  const ruleLines = ctx.text.split('\n').filter((l) => l.startsWith('- **rule-'))
  assert.equal(ruleLines.length, 39)
  for (const l of ruleLines) assert.ok(l.endsWith('…'), `shortened: ${l.slice(0, 40)}`)
})
