import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { Comms } from '../server/comms.js'
import { handle } from '../server/hooks.js'
import { LocalIdentity } from '../server/identity.js'
import { MemoryTransport } from '../server/transport.js'

const NOW = 1_800_000_000_000
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const machine = (t: MemoryTransport) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-move-'))
  dirs.push(dir)
  const local = new LocalIdentity(dir)
  const comms = new Comms(t, local, { now: () => NOW, sleep: async () => {}, liveMs: 60_000, settleMs: 0 })
  return { local, comms, dir }
}

test('a move keeps the name, and deletes the role it leaves empty, returning its work', async () => {
  // An explicit removal of the last member is the role's explicit end.
  const t = new MemoryTransport()
  const pm = machine(t)
  await pm.comms.join('pm', { create: true, as: 'pm1' })
  const s = machine(t)
  await s.comms.join('guides', { create: true, as: 'docs1' })
  await s.comms.createRole('docs-dev', 'docs1')
  await pm.comms.send('pm1', 'guides', 'write the setup guide')

  const r = await s.comms.move('docs1', 'guides', 'docs-dev')

  assert.equal(r.deleted, true)
  assert.equal(r.returned, 1, 'unhandled work goes back to its sender')
  const roles = (await s.comms.roles()).map((x) => x.role)
  assert.ok(roles.includes('docs-dev') && !roles.includes('guides'))
  assert.ok((await s.comms.manifest('docs-dev'))!.members.some((m) => m.name === 'docs1'))
})

test('a move out of a role others are still in leaves the role and its queue alone', async () => {
  const t = new MemoryTransport()
  const a = machine(t)
  await a.comms.join('crew', { create: true, as: 'crew1' })
  const b = machine(t)
  await b.comms.join('crew', { as: 'crew2' })
  await b.comms.createRole('ops', 'crew2')

  const r = await b.comms.move('crew2', 'crew', 'ops')

  assert.equal(r.deleted, false)
  assert.deepEqual((await a.comms.manifest('crew'))!.members.map((m) => m.name), ['crew1'])
})

test('--keep keeps an emptied role, and a closed session never empties one', async () => {
  const t = new MemoryTransport()
  const a = machine(t)
  await a.comms.join('solo', { create: true, as: 'solo1' })
  assert.equal((await a.comms.leaveRole('solo', 'solo1', { keep: true })).deleted, false)
  assert.ok(await a.comms.manifest('solo'), 'still there')
})

test('a move reports claims it leaves behind instead of refusing', async () => {
  const t = new MemoryTransport()
  const pm = machine(t)
  await pm.comms.join('pm', { create: true, as: 'pm1' })
  const s = machine(t)
  await s.comms.join('crew', { create: true, as: 'crew1' })
  await s.comms.createRole('ops', 'crew1')
  const sent = await pm.comms.send('pm1', 'crew', 'rotate the logs')
  assert.ok(sent.ok)
  assert.equal((await s.comms.claim('crew1', sent.id)).won, true)

  const r = await s.comms.move('crew1', 'crew', 'ops', { keep: true })
  assert.deepEqual(r.claimsLeft, [sent.id])
})

test('a rename keeps the roles under the new name and refuses to orphan claimed work', async () => {
  const t = new MemoryTransport()
  const pm = machine(t)
  await pm.comms.join('pm', { create: true, as: 'pm1' })
  const s = machine(t)
  await s.comms.join('crew', { create: true, as: 'crew1' })

  assert.deepEqual((await s.comms.rename('crew1', 'docs-writer')).roles, ['crew'])
  const names = (await s.comms.manifest('crew'))!.members.map((m) => m.name)
  assert.deepEqual(names, ['docs-writer'])
  assert.equal(s.local.member('crew1'), undefined, 'the old name is no longer held here')

  const sent = await pm.comms.send('pm1', 'crew', 'ship it')
  assert.ok(sent.ok)
  await s.comms.claim('docs-writer', sent.id)
  await assert.rejects(s.comms.rename('docs-writer', 'other'), /owns claimed work/)
})

test('a plain rename of a non-member is handed to the harness once, at the next hook', async () => {
  const t = new MemoryTransport()
  const s = machine(t)
  s.local.setPendingTitle('sess-1', 'docs-writer')
  const ctx = { name: 'comms', dir: '', dataDir: s.dir, log: () => {} } as never

  const first = await handle({ session_id: 'sess-1' }, ctx, 'UserPromptSubmit', () => s, {})
  assert.deepEqual(first, { sessionTitle: 'docs-writer' })
  assert.equal(await handle({ session_id: 'sess-1' }, ctx, 'UserPromptSubmit', () => s, {}), undefined)
})

// ── addressing (laptop step 6, session 2) ────────────────────────────────────

test('a bare member name reaches that member when no role has the name', async () => {
  const t = new MemoryTransport()
  const a = machine(t)
  await a.comms.join('general', { create: true, as: 'laptop-1' })
  const b = machine(t)
  await b.comms.join('general', { as: 'laptop-sesh-2' })
  const r = await b.comms.send('laptop-sesh-2', 'laptop-1', 'hi')
  assert.ok(r.ok, r.outcome)
  assert.deepEqual((await a.comms.inbox('laptop-1')).map((i) => [i.from, i.body]), [['general/laptop-sesh-2', 'hi']])
})

test('a name that is both a role and a member is refused with both explicit forms', async () => {
  const t = new MemoryTransport()
  const a = machine(t)
  await a.comms.join('crew', { create: true, as: 'ops' })
  await a.comms.createRole('ops', 'ops')
  const r = await a.comms.send('ops', 'ops', 'which one?')
  assert.equal(r.ok, false)
  assert.match(r.outcome, /both a role and a member: send to "role:ops" for the role, or "crew\/ops" for the member/)
  assert.ok((await a.comms.send('ops', 'role:ops', 'the role')).ok)
})
