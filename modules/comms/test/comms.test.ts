import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Comms } from '../server/comms.js'
import { LocalIdentity } from '../server/identity.js'
import { MemoryTransport } from '../server/transport.js'
import { parseAddress } from '../server/address.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'comms-'))

/** A fake clock shared by every "session" in a test, plus a sleep that advances it. */
const clock = (start = 1_800_000_000_000) => {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms), sleep: async (ms: number) => void (t += ms) }
}

const session = (transport: MemoryTransport, c: ReturnType<typeof clock>, dir = tmp()) =>
  new Comms(transport, new LocalIdentity(dir), { now: c.now, sleep: c.sleep, liveMs: 60_000, settleMs: 2_000 })

test('addresses: role, role/member, selector, and a typo is a readable error', () => {
  assert.deepEqual(parseAddress('acme-dev'), { kind: 'role', role: 'acme-dev' })
  assert.deepEqual(parseAddress('acme-dev/acme-dev-2'), { kind: 'member', role: 'acme-dev', member: 'acme-dev-2' })
  assert.deepEqual(parseAddress('acme-dev[machine=node-b]'), { kind: 'role', role: 'acme-dev', selector: { machine: 'node-b' } })
  assert.throws(() => parseAddress('Acme Dev'), /bad role name/)
  assert.throws(() => parseAddress('a/b/c'), /bad address/)
})

test('joining an unknown role fails without --create, so a typo cannot create a mailbox', async () => {
  const t = new MemoryTransport()
  const s = session(t, clock())
  await assert.rejects(() => s.join('veag-dev'), /no such role: veag-dev/)
  assert.equal((await s.roles()).length, 0)
})

test('two sessions in one role get distinct minted names and both see the manifest', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const a = session(t, c)
  const b = session(t, c)
  assert.equal(await a.join('acme-dev', { create: true }), 'acme-dev-1')
  assert.equal(await b.join('acme-dev'), 'acme-dev-2')
  const m = await a.manifest('acme-dev')
  assert.deepEqual(m!.members.map((x) => x.name), ['acme-dev-1', 'acme-dev-2'])
  assert.deepEqual(await b.manifest('acme-dev'), m, 'both sessions fold the same manifest')
})

test('send results are honest: delivered, queued, no such role, no such member, no match', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const a = session(t, c)
  const b = session(t, c)
  await a.join('pm', { create: true, as: 'pm1' })
  await b.join('acme-dev', { create: true, as: 'acme-dev-1', meta: { machine: 'node-a' } })

  assert.match((await a.send('pm1', 'acme-dev', 'do X')).outcome, /delivered to role acme-dev \(1 live member\)/)
  assert.match((await a.send('pm1', 'acme-dev/acme-dev-1', 'hi')).outcome, /delivered to acme-dev\/acme-dev-1/)
  assert.deepEqual(await a.send('pm1', 'veag-dev', 'x'), { ok: false, outcome: 'no such role: veag-dev' })
  assert.deepEqual(await a.send('pm1', 'acme-dev/acme-dev9', 'x'), { ok: false, outcome: 'no such member: acme-dev/acme-dev9' })
  assert.equal((await a.send('pm1', 'acme-dev[machine=node-b]', 'x')).ok, false)

  c.advance(10 * 60_000) // past liveMs: acme-dev-1 has gone quiet
  assert.match((await a.send('pm1', 'acme-dev', 'later')).outcome, /queued for role acme-dev \(no live members\)/)
  assert.match((await a.send('pm1', 'acme-dev/acme-dev-1', 'later')).outcome, /queued for acme-dev\/acme-dev-1 \(member offline\)/)
})

test('queued work waits durably for a member that was away, and is shown once', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const pm = session(t, c)
  const acmeDir = tmp()
  const acme = session(t, c, acmeDir)
  await pm.join('pm', { create: true, as: 'pm1' })
  await acme.join('acme-dev', { create: true, as: 'acme-dev-1' })

  c.advance(14 * 24 * 3600_000) // two weeks offline, e.g. an expired login
  await pm.send('pm1', 'acme-dev', 'work while you were out')
  await pm.send('pm1', 'acme-dev/acme-dev-1', 'a direct note')

  const back = session(t, c, acmeDir) // same machine, same member, resumed
  const items = await back.inbox('acme-dev-1')
  assert.deepEqual(items.map((i) => i.body), ['work while you were out', 'a direct note'])
  assert.equal(items[0]!.from, 'pm/pm1')
  back.markSeen('acme-dev-1', items.map((i) => i.id))
  assert.equal((await back.inbox('acme-dev-1')).length, 0)
})

test('members talk to each other through role/member, and own sends never come back', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const a = session(t, c)
  const b = session(t, c)
  await a.join('acme-dev', { create: true })
  await b.join('acme-dev')
  await a.send('acme-dev-1', 'acme-dev/acme-dev-2', 'taking the auth branch')
  await a.send('acme-dev-1', 'acme-dev', 'role-wide question')
  assert.deepEqual((await b.inbox('acme-dev-2')).map((i) => i.body), ['taking the auth branch', 'role-wide question'])
  assert.equal((await a.inbox('acme-dev-1')).length, 0, 'a sender never receives its own message')
})

test('reply goes to the sender as role/member, carrying the original id', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const pm = session(t, c)
  const acme = session(t, c)
  await pm.join('pm', { create: true, as: 'pm1' })
  await acme.join('acme-dev', { create: true, as: 'acme-dev-1' })
  const sent = await pm.send('pm1', 'acme-dev', 'status?')
  assert.equal(sent.ok, true)
  const r = await acme.reply('acme-dev-1', (sent as any).id, 'all green')
  assert.match(r.outcome, /replied to pm\/pm1/)
  const got = await pm.inbox('pm1')
  assert.equal(got[0]!.body, 'all green')
  assert.equal(got[0]!.from, 'acme-dev/acme-dev-1')
})

test('single live member claims and starts at once, with no settle wait', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const pm = session(t, c)
  const acme = session(t, c)
  await pm.join('pm', { create: true, as: 'pm1' })
  await acme.join('acme-dev', { create: true, as: 'acme-dev-1' })
  const sent = (await pm.send('pm1', 'acme-dev', 'task')) as { id: string }
  const before = c.now()
  const r = await acme.claim('acme-dev-1', sent.id)
  assert.deepEqual(r, { won: true, owner: 'acme-dev-1', waited: false })
  assert.equal(c.now(), before, 'no time spent waiting')
  const items = await acme.inbox('acme-dev-1', { includeSeen: true })
  assert.deepEqual(items[0]!.ownership, { state: 'started', owner: 'acme-dev-1' })
})

test('competing claims: earliest posted stamp wins, everyone agrees, the loser stands down', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const pm = session(t, c)
  const a = session(t, c)
  const b = session(t, c)
  await pm.join('pm', { create: true, as: 'pm1' })
  await a.join('acme-dev', { create: true })
  await b.join('acme-dev')
  const { id } = (await pm.send('pm1', 'acme-dev', 'task')) as { id: string }

  // Both claim inside the settle window. Exactly one wins and both agree who.
  const [ra, rb] = await Promise.all([a.claim('acme-dev-1', id), b.claim('acme-dev-2', id)])
  assert.equal([ra, rb].filter((r) => r.won).length, 1)
  assert.equal(ra.owner, rb.owner, 'both sessions name the same owner')
  assert.equal(ra.waited && rb.waited, true, 'with another live member each claim waits')
  assert.equal(await a.check('acme-dev-1', id), ra.won)
  assert.equal(await b.check('acme-dev-2', id), rb.won)
})

test('earliest posted stamp wins regardless of member name or arrival order', async () => {
  const { ownership } = await import('../server/claims.js')
  const claims = [
    { v: 1 as const, type: 'claim' as const, stamp: 20, from: 'acme-dev/acme-dev-1', ref: 'm', id: 'x1' },
    { v: 1 as const, type: 'claim' as const, stamp: 10, from: 'acme-dev/acme-dev-2', ref: 'm', id: 'x2' },
  ]
  assert.deepEqual(ownership('m', claims), { state: 'claimed', owner: 'acme-dev-2', claimId: 'x2' })
  assert.deepEqual(ownership('m', [...claims].reverse()), ownership('m', claims))
})

test('rule (a): exact-equal stamps break ties by member name', async () => {
  const { ownership } = await import('../server/claims.js')
  const claims = [
    { v: 1 as const, type: 'claim' as const, stamp: 5, from: 'acme-dev/acme-dev-2', ref: 'm', id: 'x1' },
    { v: 1 as const, type: 'claim' as const, stamp: 5, from: 'acme-dev/acme-dev-1', ref: 'm', id: 'x2' },
  ]
  assert.deepEqual(ownership('m', claims), { state: 'claimed', owner: 'acme-dev-1', claimId: 'x2' })
})

test('rule (b): once started, a later-arriving claim loses even with an earlier stamp', async () => {
  const { ownership } = await import('../server/claims.js')
  const posted = [
    { v: 1 as const, type: 'claim' as const, stamp: 100, from: 'r/late', ref: 'm', id: 'c1' },
    { v: 1 as const, type: 'started' as const, stamp: 100, from: 'r/late', ref: 'm', id: 's1' },
    { v: 1 as const, type: 'claim' as const, stamp: 50, from: 'r/early', ref: 'm', id: 'c2' }, // arrived after started
  ]
  assert.deepEqual(ownership('m', posted), { state: 'started', owner: 'late' })
})

test('a claim on work someone already started is refused without posting', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const pm = session(t, c)
  const a = session(t, c)
  const b = session(t, c)
  await pm.join('pm', { create: true, as: 'pm1' })
  await a.join('acme-dev', { create: true })
  await b.join('acme-dev')
  const { id } = (await pm.send('pm1', 'acme-dev', 'task')) as { id: string }
  assert.equal((await a.claim('acme-dev-1', id)).won, true)
  assert.deepEqual(await b.claim('acme-dev-2', id), { won: false, owner: 'acme-dev-1', waited: false })
})

test('network split: both sides start, and after healing exactly one still owns it', async () => {
  const c = clock()
  const shared = new MemoryTransport()
  const pm = session(shared, c)
  await pm.join('pm', { create: true, as: 'pm1' })
  const left = session(shared, c)
  await left.join('acme-dev', { create: true })
  const right = session(shared, c)
  await right.join('acme-dev')
  const { id } = (await pm.send('pm1', 'acme-dev', 'task')) as { id: string }

  // Split: each side keeps its own copy of the log from here on.
  const L = MemoryTransport.withPrefix('L')
  const R = MemoryTransport.withPrefix('R')
  L.absorb(shared)
  R.absorb(shared)
  const leftSide = new Comms(L, (left as any).local, { now: c.now, sleep: c.sleep, liveMs: 60_000, settleMs: 2_000 })
  const rightSide = new Comms(R, (right as any).local, { now: c.now, sleep: c.sleep, liveMs: 60_000, settleMs: 2_000 })
  c.advance(1)
  assert.equal((await rightSide.claim('acme-dev-2', id)).won, true) // right claims first
  c.advance(1)
  assert.equal((await leftSide.claim('acme-dev-1', id)).won, true) // left never saw it

  // Heal: every node folds the same log.
  L.absorb(R)
  R.absorb(L)
  assert.equal(await rightSide.check('acme-dev-2', id), true)
  assert.equal(await leftSide.check('acme-dev-1', id), false, 'the fencing check stops the loser')
})

test('deleting a role returns unclaimed work to its senders and later sends fail', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const pm = session(t, c)
  const acme = session(t, c)
  await pm.join('pm', { create: true, as: 'pm1' })
  await acme.join('acme-dev', { create: true, as: 'acme-dev-1' })
  await pm.send('pm1', 'acme-dev', 'never handled')
  assert.equal(await acme.deleteRole('acme-dev', 'acme-dev-1'), 1)
  const notices = await pm.inbox('pm1')
  assert.match(notices[0]!.body, /role acme-dev was deleted before your message .* was handled: never handled/)
  assert.deepEqual(await pm.send('pm1', 'acme-dev', 'x'), { ok: false, outcome: 'no such role: acme-dev' })
})

test('a re-created role starts a new epoch, so old messages never leak in', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const pm = session(t, c)
  const acme = session(t, c)
  await pm.join('pm', { create: true, as: 'pm1' })
  await acme.join('acme-dev', { create: true, as: 'acme-dev-1' })
  await pm.send('pm1', 'acme-dev', 'old')
  await acme.deleteRole('acme-dev', 'acme-dev-1')
  await acme.join('acme-dev', { create: true, as: 'acme-dev-1' })
  await pm.send('pm1', 'acme-dev', 'new')
  assert.deepEqual((await acme.inbox('acme-dev-1')).map((i) => i.body), ['new'])
  assert.equal((await acme.manifest('acme-dev'))!.epoch, 2)
})

test('a notify message reaches every member and is never claimable', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const pm = session(t, c)
  const a = session(t, c)
  const b = session(t, c)
  await pm.join('pm', { create: true, as: 'pm1' })
  await a.join('acme-dev', { create: true })
  await b.join('acme-dev')
  const { id } = (await pm.send('pm1', 'acme-dev', 'stop', { notify: true })) as { id: string }
  assert.equal((await a.inbox('acme-dev-1'))[0]!.notify, true)
  assert.equal((await b.inbox('acme-dev-2'))[0]!.notify, true)
  await assert.rejects(() => a.claim('acme-dev-1', id), /notify message/)
})

test('a selector limits who sees the work to members whose declared metadata matches', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const pm = session(t, c)
  const a = session(t, c)
  const b = session(t, c)
  await pm.join('pm', { create: true, as: 'pm1' })
  await a.join('acme-dev', { create: true, meta: { machine: 'node-a', cap: 'docker' } })
  await b.join('acme-dev', { meta: { machine: 'node-b', cap: 'browser,docker' } })
  await pm.send('pm1', 'acme-dev[cap=browser]', 'needs a browser')
  assert.equal((await a.inbox('acme-dev-1')).length, 0)
  assert.equal((await b.inbox('acme-dev-2')).length, 1)
})

test('a member name held by a session on another machine cannot be taken', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const a = session(t, c)
  const b = session(t, c)
  await a.join('acme-dev', { create: true, as: 'acme-dev-1' })
  await assert.rejects(() => b.join('acme-dev', { as: 'acme-dev-1' }), /belongs to a session on another machine/)
})

test('every node folds the same registry regardless of the order events were read in', async () => {
  const { foldRegistry } = await import('../server/registry.js')
  const t = new MemoryTransport()
  const c = clock()
  const a = session(t, c)
  await a.join('acme-dev', { create: true })
  c.advance(5)
  await a.join('pm', { create: true, as: 'pm1' })
  const events = await t.read('cortex-comms:registry')
  const fwd = foldRegistry(events)
  const rev = foldRegistry([...events].reverse())
  assert.deepEqual([...rev.members.keys()].sort(), [...fwd.members.keys()].sort())
  assert.deepEqual([...rev.roles.keys()].sort(), [...fwd.roles.keys()].sort())
})

test('a silent message is for a program: never in the ordinary inbox (so a watcher cannot show or consume it), read apart', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const svc = session(t, c)
  const me = session(t, c)
  await svc.join('svc', { create: true, as: 'svc-1' })
  await me.join('pm', { create: true, as: 'pm-1' })
  assert.ok((await svc.send('svc-1', 'pm/pm-1', '{"result":1}', { silent: true })).ok)
  assert.ok((await svc.send('svc-1', 'pm/pm-1', 'a person should see this')).ok)
  const human = await me.inbox('pm-1')
  assert.deepEqual(human.map((i) => i.body), ['a person should see this'])
  me.markSeen('pm-1', human.map((i) => i.id)) // what a watcher does
  const program = await me.inbox('pm-1', { silent: true })
  assert.deepEqual(program.map((i) => i.body), ['{"result":1}'], 'the watcher marking its messages seen left the result alone')
  me.markSeen('pm-1', program.map((i) => i.id))
  assert.equal((await me.inbox('pm-1', { silent: true })).length, 0)
})

test('leaving the last role forgets the local member record; leaving one of two keeps it', async () => {
  const t = new MemoryTransport()
  const c = clock()
  const dir = tmp()
  const s = session(t, c, dir)
  await s.join('a', { create: true, as: 'm-1' })
  await s.join('b', { create: true, as: 'm-1' })
  await s.leaveRole('a', 'm-1')
  assert.ok(fs.existsSync(path.join(dir, 'members', 'm-1.json')))
  await s.leaveRole('b', 'm-1')
  assert.ok(!fs.existsSync(path.join(dir, 'members', 'm-1.json')))
})
