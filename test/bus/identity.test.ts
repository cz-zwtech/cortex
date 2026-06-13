#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import {
  resolveFriendlyName,
  presenceStatus,
  shouldRebind,
  LIVE_MS,
  STALE_MS,
  mintMetaId,
  aliasSetFor,
  selfIdSet,
  deliveredToSelf,
  priorIncarnations,
  splitHistory,
  joinHistory,
  foldNameHistory,
  BROADCAST,
} from '../../server/bus/identity.js'

// resolveFriendlyName: title > autoName > id-prefix
assert.equal(resolveFriendlyName({ title: 'swarm-driver', autoName: 'x', sessionId: 'abc12345' }), 'swarm-driver')
assert.equal(resolveFriendlyName({ title: '', autoName: 'auto-name', sessionId: 'abc12345' }), 'auto-name')
assert.equal(resolveFriendlyName({ title: '', autoName: '', sessionId: 'abc12345def' }), 'abc12345')

// presenceStatus: signed_off is sticky; else derived from age
const now = 1_000_000_000_000
assert.equal(presenceStatus({ lastSeen: now, rawStatus: 'signed_off' }, now), 'signed_off')
assert.equal(presenceStatus({ lastSeen: now - 1000, rawStatus: 'live' }, now), 'live')
assert.equal(presenceStatus({ lastSeen: now - (LIVE_MS + 1000), rawStatus: 'live' }, now), 'idle')
assert.equal(presenceStatus({ lastSeen: now - (STALE_MS + 1000), rawStatus: 'live' }, now), 'stale')

// shouldRebind: same name+cwd, different id, prior is live
assert.equal(shouldRebind({ friendlyName: 'a', cwd: '/p', sessionId: 'new' }, { friendlyName: 'a', cwd: '/p', sessionId: 'old', status: 'live' }), true)
assert.equal(shouldRebind({ friendlyName: 'a', cwd: '/p', sessionId: 'new' }, { friendlyName: 'a', cwd: '/p', sessionId: 'new', status: 'live' }), false) // same id
assert.equal(shouldRebind({ friendlyName: 'a', cwd: '/p', sessionId: 'new' }, { friendlyName: 'b', cwd: '/p', sessionId: 'old', status: 'live' }), false) // diff name

// ── metaId + alias set (shared-stream identity) ──────────────────────────────

// mintMetaId: prefixed + unique
const m1 = mintMetaId()
const m2 = mintMetaId()
assert.match(m1, /^meta_/, 'metaId is prefixed')
assert.notEqual(m1, m2, 'metaIds are unique')

// aliasSetFor: includes sessionId, metaId, current name, every retired name, '*'
const aset = aliasSetFor({
  sessionId: 'sid-123',
  metaId: 'meta_abc',
  friendlyName: 'zw-installer',
  nameHistory: ['old-name-1', 'project manager agent'],
})
for (const a of ['sid-123', 'meta_abc', 'zw-installer', 'old-name-1', 'project manager agent', BROADCAST]) {
  assert.ok(aset.has(a), `alias set contains ${a}`)
}
// empties are dropped — a blank field must NOT swallow blank-`to` messages
const sparse = aliasSetFor({ sessionId: 'only-sid' })
assert.ok(sparse.has('only-sid') && sparse.has('*'), 'sparse alias set keeps sid + *')
assert.ok(!sparse.has(''), 'alias set never contains the empty string')

// THE black-hole regression at the unit level: a message addressed to a RETIRED
// name still matches the reader's alias set after a rename.
assert.ok(aset.has('project manager agent'), 'retired name still resolves (no orphan)')

// THE short-PREFIX black-hole (found 2026-06-09): a /rename'd session must STILL
// answer to its 8-char id prefix. Every UI/peer display shows `(411f5f18)`, so
// peers naturally address the prefix — but a rename replaced the default-prefix
// friendly name, dropping the prefix from the alias set → 3 real PM messages
// black-holed. The prefix must be a PERMANENT, rename-independent alias.
const renamed = aliasSetFor({
  sessionId: '411f5f18-0229-45cb-a437-5c37b7003b7f',
  metaId: 'meta_2lAMd55sr',
  friendlyName: 'cortex-dev', // renamed ⇒ prefix is NOT the friendly name
})
assert.ok(renamed.has('411f5f18'), 'renamed session still answers to its 8-char short prefix (black-hole fix)')
assert.ok(renamed.has('411f5f18-0229-45cb-a437-5c37b7003b7f'), 'full id still resolves')
assert.ok(renamed.has('cortex-dev'), 'custom name still resolves')
// a session id shorter than 8 chars: prefix == id, no spurious/empty entries
const shortId = aliasSetFor({ sessionId: 'abc' })
assert.ok(shortId.has('abc') && !shortId.has(''), 'short id resolves with no empty alias')

// ── stable identity across compact/resume (decision #5 / stage 3B) ──
// sibling incarnations sharing the metaId: their ids + prefixes are aliases too,
// so a peer addressing a PRIOR incarnation (or its prefix) reaches the live one.
const withSibs = aliasSetFor({
  sessionId: 'new5e3a-aaaa-bbbb-cccc-dddddddddddd',
  metaId: 'meta_durable',
  siblingIds: ['824d2d38-4033-4a38-8cf9-7583165be081', '6d56cecc-b8ad-48f0-9bc5-12209fbd6adf'],
})
assert.ok(withSibs.has('824d2d38-4033-4a38-8cf9-7583165be081'), 'prior incarnation full id resolves')
assert.ok(withSibs.has('824d2d38'), 'prior incarnation SHORT prefix resolves (the 824d2d38↔6d56cecc split fix)')
assert.ok(withSibs.has('6d56cecc'), 'second sibling prefix resolves')
assert.ok(withSibs.has('meta_durable'), 'the durable metaId resolves')

// selfIdSet: own id + all siblings (excludes own-past sends + dedups delivery)
const sids = selfIdSet('cur', ['old1', 'old2', ''])
assert.deepEqual([...sids].sort(), ['cur', 'old1', 'old2'].sort(), 'selfIdSet = own id + siblings, empties dropped')

// deliveredToSelf: delivered to ANY incarnation counts as delivered (no re-flood)
assert.equal(deliveredToSelf(['old1'], sids), true, 'a message delivered to a PRIOR incarnation is not re-flooded after resume')
assert.equal(deliveredToSelf(['someone-else'], sids), false, 'a message not delivered to any of my ids is still pending (no drop)')
assert.equal(deliveredToSelf([], sids), false, 'never-delivered is pending')

// ── priorIncarnations: a LIVE sibling is a concurrent voice, NOT me-across-resume ──
// (defends stable-identity against legacy over-merged metaIds — the cwd-reclaim bug
// collapsed 4 concurrent sessions onto one metaId.)
const tnow = 1_000_000_000_000
const sibs = [
  { id: 'signed', rawStatus: 'signed_off', lastSeen: tnow }, // ended → my prior incarnation
  { id: 'quiet', rawStatus: 'live', lastSeen: tnow - (LIVE_MS + 1) }, // gone quiet → prior incarnation
  { id: 'concurrent', rawStatus: 'live', lastSeen: tnow - 1000 }, // LIVE now → different session
]
const incs = priorIncarnations(sibs, tnow).map((s) => s.id).sort()
assert.deepEqual(incs, ['quiet', 'signed'].sort(), 'live concurrent sibling is EXCLUDED; signed_off + quiet are incarnations')
assert.ok(!incs.includes('concurrent'), 'a concurrently-live session sharing the metaId is never treated as my incarnation (cross-bleed guard)')

// history (de)serialisation
assert.deepEqual(splitHistory('a, b ,,c'), ['a', 'b', 'c'], 'splitHistory trims + drops empties')
assert.equal(joinHistory(['a', 'a', 'b', '']), 'a,b', 'joinHistory dedupes + drops empties')

// foldNameHistory: prior name retained, current name excluded, deduped
assert.deepEqual(
  foldNameHistory(['old1'], 'cur-prior', 'cur-now').sort(),
  ['cur-prior', 'old1'].sort(),
  'rename retains the prior name in history',
)
assert.deepEqual(foldNameHistory(['x'], 'same', 'same'), ['x'], 'no-op rename adds nothing')
assert.ok(
  !foldNameHistory(['cur-now', 'old1'], 'old1', 'cur-now').includes('cur-now'),
  'current name is not duplicated into history',
)

console.log('identity.test.ts: all assertions passed')
