#!/usr/bin/env tsx
/**
 * Bus pagination pure core (slice 1): split a long body into mesh-safe parts
 * carrying a body-header, and reassemble them at read time with idempotent
 * SET-semantics (dedupe by groupId+k). Backward-compatible: a part is a normal
 * message whose body an older node still reads; reassembly is purely at the
 * read layer (within the protocol freeze — no new message fields).
 *
 * Pure (no DB / no server) — mirrors test/graph/branch-policy.test.ts.
 */
import assert from 'node:assert/strict'

const { paginateBody, parsePageHeader, reassembleList, PageReassembler } = await import('../../bin/_bus-paginate.js')

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── paginateBody: short bodies are untouched ────────────────────────────────
{
  const short = 'a quick message'
  assert.deepEqual(paginateBody(short, 'g1', 100), [short], 'short body returned unchanged, no header')
  assert.equal(parsePageHeader(short), null, 'a plain body has no page header')
  ok('short body is not paginated')
}

// ── paginateBody: long bodies split into header-tagged parts that round-trip ─
{
  const body = 'X'.repeat(250)
  const parts = paginateBody(body, 'grp', 100)
  assert.ok(parts.length >= 3, `split into >=3 parts (got ${parts.length})`)
  let rejoined = ''
  parts.forEach((p, i) => {
    const h = parsePageHeader(p)
    assert.ok(h, `part ${i} has a page header`)
    assert.equal(h!.groupId, 'grp', 'groupId preserved')
    assert.equal(h!.k, i + 1, 'k is 1-based and in order')
    assert.equal(h!.n, parts.length, 'n is the total part count')
    rejoined += h!.chunk
  })
  assert.equal(rejoined, body, 'chunks concatenate back to the original body')
  ok('long body splits into ordered, header-tagged parts that round-trip')
}

// ── reassembleList: non-paginated messages pass through ─────────────────────
{
  const msgs = [{ id: 'm1', body: 'hello', fromName: 'peer' }]
  const out = reassembleList(msgs)
  assert.equal(out.length, 1, 'one message out')
  assert.equal(out[0]!.body, 'hello', 'body unchanged')
  assert.deepEqual(out[0]!.partIds, ['m1'], 'partIds = [its own id]')
  assert.equal(out[0]!.fromName, 'peer', 'other fields preserved')
  ok('non-paginated message passes through with partIds=[id]')
}

// ── reassembleList: a complete group merges into one message ────────────────
{
  const body = 'Y'.repeat(250)
  const parts = paginateBody(body, 'gA', 100)
  const msgs = parts.map((p, i) => ({ id: `p${i + 1}`, body: p, fromName: 'driver' }))
  const out = reassembleList(msgs)
  assert.equal(out.length, 1, 'group collapses to one message')
  assert.equal(out[0]!.body, body, 'reassembled body equals the original')
  assert.deepEqual(out[0]!.partIds, ['p1', 'p2', 'p3'], 'partIds lists every constituent part (k-order)')
  assert.equal(out[0]!.fromName, 'driver', 'representative keeps the sender metadata')
  ok('complete group reassembles, carrying all partIds for delivered-marking')
}

// ── reassembleList: idempotent SET-semantics — duplicate parts don't double ─
{
  const body = 'Z'.repeat(150)
  const parts = paginateBody(body, 'gB', 100) // 2 parts
  const msgs = [
    { id: 'd1', body: parts[0]! },
    { id: 'd1-dup', body: parts[0]! }, // duplicate of k=1
    { id: 'd2', body: parts[1]! },
  ]
  const out = reassembleList(msgs)
  assert.equal(out.length, 1, 'one merged message despite the duplicate')
  assert.equal(out[0]!.body, body, 'body reassembles correctly (no double-join)')
  ok('duplicate part (same k) is deduped — idempotent set-semantics')
}

// ── reassembleList: incomplete group passes parts through (nothing hidden) ──
{
  const parts = paginateBody('W'.repeat(250), 'gC', 100) // 3 parts
  const msgs = [{ id: 'only1', body: parts[0]! }] // only k=1 of 3 arrived
  const out = reassembleList(msgs)
  assert.equal(out.length, 1, 'the lone part is not dropped')
  assert.equal(out[0]!.body, parts[0], 'incomplete part passed through unchanged')
  ok('incomplete group is passed through, never silently dropped')
}

// ── reassembleList: order preserved, merged at the first part position ──────
{
  const parts = paginateBody('Q'.repeat(150), 'gD', 100) // 2 parts
  const msgs = [
    { id: 'a', body: 'standalone-before' },
    { id: 'g1', body: parts[0]! },
    { id: 'g2', body: parts[1]! },
    { id: 'b', body: 'standalone-after' },
  ]
  const out = reassembleList(msgs)
  assert.deepEqual(out.map((m) => m.id), ['a', 'g1', 'b'], 'merged group sits at its first part position; order kept')
  ok('ordering preserved with the merged group at its first-part slot')
}

// ── PageReassembler: streaming reassembly for the watch surface ─────────────
{
  const parts = paginateBody('R'.repeat(250), 'sg', 100) // 3 parts
  const r = new PageReassembler()

  const plain = r.offer({ id: 'x', body: 'plain msg' })
  assert.ok(plain && plain.body === 'plain msg', 'non-paginated message emitted immediately')
  assert.deepEqual(plain!.partIds, ['x'], 'non-paginated partIds=[id]')

  assert.equal(r.offer({ id: 'k1', body: parts[0]! }), null, 'part 1 buffered (null)')
  assert.equal(r.offer({ id: 'k2', body: parts[1]! }), null, 'part 2 buffered (null)')
  const whole = r.offer({ id: 'k3', body: parts[2]! })
  assert.ok(whole, 'final part completes the group → whole message returned')
  assert.equal(whole!.body, 'R'.repeat(250), 'streamed reassembly equals the original body')
  assert.deepEqual(whole!.partIds, ['k1', 'k2', 'k3'], 'whole carries every constituent part id')
  ok('PageReassembler buffers parts and emits the whole message on completion')
}

// ── PageReassembler: out-of-order parts still complete ──────────────────────
{
  const parts = paginateBody('S'.repeat(150), 'oo', 100) // 2 parts
  const r = new PageReassembler()
  assert.equal(r.offer({ id: 'b', body: parts[1]! }), null, 'part 2 arrives first → buffered')
  const whole = r.offer({ id: 'a', body: parts[0]! })
  assert.ok(whole && whole.body === 'S'.repeat(150), 'out-of-order arrival reassembles correctly')
  assert.deepEqual(whole!.partIds, ['a', 'b'], 'partIds in k-order regardless of arrival order')
  ok('PageReassembler handles out-of-order part arrival')
}

console.log(`\nOK paginate.test.ts — ${passed} assertions passed`)
