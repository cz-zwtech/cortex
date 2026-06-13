#!/usr/bin/env tsx
/**
 * Thread hydrate — the resume-UX DEPTH follow-on (ratified parallelism principle
 * [[cortex-resume-ux-and-parallelism-design]]). The fast head+ACK returns
 * immediately; the linked-memory reads hydrate IN PARALLEL behind it. hydrateLinks
 * fans the per-link fetches out concurrently (one call = the whole back-story);
 * renderHydrate formats the bundle, flagging unwritten forward-links.
 */
import assert from 'node:assert/strict'
import { hydrateLinks, renderHydrate } from '../../bin/_thread-hydrate.ts'

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. fetches every link concurrently; preserves input order; truncates excerpt
{
  const calls: string[] = []
  const order: string[] = []
  const fetchOne = async (slug: string) => {
    calls.push(slug)
    // resolve in REVERSE arrival so a sequential impl would reorder; Promise.all
    // preserves input order regardless — proves we map by index, not completion.
    await new Promise((r) => setTimeout(r, slug === 'a' ? 20 : 1))
    order.push(slug)
    return { description: `desc ${slug}`, body: 'x'.repeat(500) }
  }
  const out = await hydrateLinks(['a', 'b', 'c'], fetchOne)
  assert.deepEqual(out.map((r) => r.slug), ['a', 'b', 'c'], 'results keep input order')
  assert.deepEqual(calls.sort(), ['a', 'b', 'c'], 'every link fetched')
  assert.ok(out.every((r) => r.found), 'all found')
  assert.ok(out[0]!.excerpt!.length <= 280, 'excerpt is truncated')
  assert.ok(order.indexOf('b') < order.indexOf('a'), 'fetches ran concurrently (b finished before slow a)')
  ok('hydrateLinks fans out concurrently, order-preserving, excerpt-capped')
}

// ── 2. a missing link (no graph entry) is marked not-found, never throws
{
  const fetchOne = async (slug: string) => (slug === 'gone' ? null : { description: 'd', body: 'b' })
  const out = await hydrateLinks(['here', 'gone'], fetchOne)
  assert.equal(out.find((r) => r.slug === 'gone')!.found, false, 'missing link → found:false')
  assert.equal(out.find((r) => r.slug === 'here')!.found, true, 'present link → found:true')
  ok('missing link handled gracefully')
}

// ── 3. a fetch that throws degrades to not-found (one bad link never sinks the bundle)
{
  const fetchOne = async (slug: string) => {
    if (slug === 'boom') throw new Error('network')
    return { description: 'd', body: 'b' }
  }
  const out = await hydrateLinks(['ok', 'boom'], fetchOne)
  assert.equal(out.find((r) => r.slug === 'boom')!.found, false, 'thrown fetch → found:false, not a crash')
  ok('a throwing fetch degrades to not-found')
}

// ── 4. renderHydrate: per-link slug + excerpt, flags unwritten forward-links, header
{
  const results = [
    { slug: 'real-one', found: true, description: 'the charter', excerpt: 'body excerpt here' },
    { slug: 'unwritten', found: false },
  ] as Awaited<ReturnType<typeof hydrateLinks>>
  const text = renderHydrate({ id: 'thread:x', nextStep: 'do the thing' }, results)
  assert.match(text, /thread:x/, 'names the thread')
  assert.match(text, /do the thing/, 'carries the next_step for orientation')
  assert.match(text, /real-one/, 'lists the resolved link slug')
  assert.match(text, /the charter/, 'includes the description')
  assert.match(text, /body excerpt here/, 'includes the excerpt')
  assert.match(text, /unwritten/, 'lists the unresolved link')
  assert.match(text, /forward-link|not (found|written)/i, 'flags the unwritten forward-link')
  ok('renderHydrate bundles links + flags unwritten ones')
}

// ── 5. ellipsis nit (Fable): a body of EXACTLY the cap is NOT truncated → no '…';
//      one char over IS. Track pre-slice length, not the post-slice excerpt length.
{
  const out280 = await hydrateLinks(['x'], async () => ({ description: 'd', body: 'y'.repeat(280) }))
  assert.equal(out280[0]!.truncated, false, 'a body of exactly 280 is not truncated')
  assert.ok(!renderHydrate({ id: 't' }, out280).includes('…'), 'no spurious ellipsis at exactly the cap')

  const out281 = await hydrateLinks(['x'], async () => ({ description: 'd', body: 'y'.repeat(281) }))
  assert.equal(out281[0]!.truncated, true, 'a body of 281 IS truncated')
  assert.ok(renderHydrate({ id: 't' }, out281).includes('…'), 'ellipsis when genuinely truncated')
  ok('ellipsis reflects real truncation, not post-slice length')
}

// ── 6. bounded fan-out (Fable): a thread with many links still fetches all of
//      them, order-preserved (chunked concurrency, not one unbounded Promise.all).
{
  const links = Array.from({ length: 25 }, (_, i) => `link-${i}`)
  const seen: string[] = []
  const out = await hydrateLinks(links, async (slug) => { seen.push(slug); return { body: slug } })
  assert.equal(out.length, 25, 'all 25 links fetched')
  assert.deepEqual(out.map((r) => r.slug), links, 'order preserved across chunks')
  assert.equal(seen.length, 25, 'every link fetched exactly once')
  ok('bounded fan-out fetches all links, order-preserved')
}

console.log(`\nOK thread-hydrate.test.ts — ${passed} assertions passed`)
