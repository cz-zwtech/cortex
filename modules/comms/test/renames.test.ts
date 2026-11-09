import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { Comms } from '../server/comms.js'
import { handle } from '../server/hooks.js'
import { LocalIdentity } from '../server/identity.js'
import { completeHeld, followRename, heldRenames } from '../server/renames.js'
import { MemoryTransport } from '../server/transport.js'

const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-renames-'))
  dirs.push(d)
  return d
}

/** A session bound to member crew-1 in role crew, and a pm to send it work. */
const setup = async () => {
  const dir = tmp()
  const t = new MemoryTransport()
  const local = new LocalIdentity(dir)
  const comms = new Comms(t, local)
  const pm = new Comms(t, new LocalIdentity(tmp()))
  await comms.join('crew', { create: true, as: 'crew-1' })
  await pm.join('pm', { create: true, as: 'pm-1' })
  local.bindSession('s1', 'crew-1')
  return { dir, local, comms, pm }
}
const renamed = (to: string, args: string[] = [], force = false) => ({ sessionId: 's1', from: 'crew-1', to, args, force, source: 'cli' as const })

test('the member follows a rename in the same roles, and the session is bound to the new name', async () => {
  const { dir, local, comms } = await setup()
  const r = await followRename(dir, local, comms, renamed('crew-lead'), {})
  assert.deepEqual(r.lines, ['renamed member crew-1 to crew-lead in crew'])
  assert.equal(local.sessionMember('s1'), 'crew-lead')
  assert.deepEqual([...((await comms.state()).reg.members.get('crew-lead')?.roles ?? [])], ['crew'])
})

test('[role]: after following the rename the session joins the role under its name, creating it if needed', async () => {
  const { dir, local, comms } = await setup()
  const r = await followRename(dir, local, comms, renamed('docs-dev', ['docs']), {})
  assert.equal(r.lines[0], 'renamed member crew-1 to docs-dev in crew')
  assert.equal(r.lines[1], 'created role docs (it did not exist) and joined as docs-dev')
  assert.match(r.lines[2]!, /^Do this now: To receive messages as they arrive, start a Monitor/)
  assert.deepEqual([...((await comms.state()).reg.members.get('docs-dev')?.roles ?? [])].sort(), ['crew', 'docs'])
})

test('a session that is not a member: [role] joins under the new name; a plain rename is title only', async () => {
  const dir = tmp()
  const local = new LocalIdentity(dir)
  const comms = new Comms(new MemoryTransport(), local)
  assert.deepEqual((await followRename(dir, local, comms, { ...renamed('solo'), from: undefined }, {})).lines, [])
  const r = await followRename(dir, local, comms, { ...renamed('acme-dev', ['acme-dev']), from: undefined }, {})
  assert.equal(r.lines[0], 'created role acme-dev (it did not exist) and joined as acme-dev')
  assert.equal(local.sessionMember('s1'), 'acme-dev')
})

test('HELD: a member owning claimed work keeps its name; the rename is recorded, said, and completes when the last claim is done', async () => {
  const { dir, local, comms, pm } = await setup()
  const a = (await pm.send('pm-1', 'crew', 'task a')) as { id: string }
  const b = (await pm.send('pm-1', 'crew', 'task b')) as { id: string }
  await comms.claim('crew-1', a.id)
  await comms.claim('crew-1', b.id)

  const r = await followRename(dir, local, comms, renamed('crew-lead'), {})
  assert.match(r.lines[0]!, /^member crew-1 keeps its name while it owns claimed work \(.+, .+\); it becomes crew-lead by itself once they are released, or now with \/cortex-rename crew-lead --force$/)
  assert.equal(local.sessionMember('s1'), 'crew-1')
  assert.equal(heldRenames(dir)['crew-1']?.to, 'crew-lead')

  await comms.done('crew-1', a.id)
  assert.equal(await completeHeld(dir, local, comms, 'crew-1', {}), undefined, 'one claim left: still held')
  await comms.done('crew-1', b.id)
  assert.match((await completeHeld(dir, local, comms, 'crew-1', {}))!, /member crew-1 is now crew-lead in crew; its claimed work is released/)
  assert.equal(local.sessionMember('s1'), 'crew-lead')
  assert.deepEqual(heldRenames(dir), {})
  assert.equal(await completeHeld(dir, local, comms, 'crew-lead', {}), undefined, 'said once')
})

test('--force renames at once despite claims, and clears a held rename', async () => {
  const { dir, local, comms, pm } = await setup()
  const a = (await pm.send('pm-1', 'crew', 'task')) as { id: string }
  await comms.claim('crew-1', a.id)
  await followRename(dir, local, comms, renamed('crew-lead'), {})
  const r = await followRename(dir, local, comms, renamed('crew-lead', [], true), {})
  assert.deepEqual(r.lines, ['renamed member crew-1 to crew-lead in crew'])
  assert.deepEqual(heldRenames(dir), {})
})

test('a held rename: the hook does not set the title back, and completes it at the next prompt once released', async () => {
  const { dir, local, comms, pm } = await setup()
  const a = (await pm.send('pm-1', 'crew', 'task')) as { id: string }
  await comms.claim('crew-1', a.id)
  await followRename(dir, local, comms, renamed('crew-lead'), {})
  const ctx = { name: 'comms', dir, dataDir: dir, log: () => {} } as never
  const open = () => ({ local, comms })

  // The harness already shows the new title; the member is still crew-1.
  const held = (await handle({ session_id: 's1', session_title: 'crew-lead' }, ctx, 'UserPromptSubmit', open, {})) as Record<string, string> | undefined
  assert.equal(held?.sessionTitle, undefined, 'no title fight while held')

  await comms.done('crew-1', a.id)
  const r = (await handle({ session_id: 's1', session_title: 'crew-lead' }, ctx, 'UserPromptSubmit', open, {})) as Record<string, string>
  assert.match(r.additionalContext ?? "", /member crew-1 is now crew-lead in crew/)
  assert.equal(local.sessionMember('s1'), 'crew-lead')
})

test('done ends only the owner\'s started work', async () => {
  const { comms, pm } = await setup()
  const a = (await pm.send('pm-1', 'crew', 'task')) as { id: string }
  await assert.rejects(() => comms.done('crew-1', a.id), /not crew-1's started work \(unclaimed\)/)
  await comms.claim('crew-1', a.id)
  assert.deepEqual(await comms.claimsOf('crew-1', 'crew'), [a.id])
  await comms.done('crew-1', a.id)
  assert.deepEqual(await comms.claimsOf('crew-1', 'crew'), [])
  assert.equal(await comms.check('crew-1', a.id), false, 'fencing: finished work is not acted on')
})

test('a held rename is listed in status until it completes', async () => {
  const { dir, local, comms, pm } = await setup()
  const a = (await pm.send('pm-1', 'crew', 'task')) as { id: string }
  await comms.claim('crew-1', a.id)
  await followRename(dir, local, comms, renamed('crew-lead'), {})
  const { default: mod } = await import('../server/index.js')
  const ctx = { name: 'comms', dir, dataDir: dir, log: () => {} } as never
  assert.match(mod.status!(ctx).warnings?.[0] ?? '', /^rename held: crew-1 becomes crew-lead once its claimed work is released \(crew-1 owns claimed work .+; or \/cortex-rename crew-lead --force$/)
  await comms.done('crew-1', a.id)
  await completeHeld(dir, local, comms, 'crew-1', {})
  assert.equal(mod.status!(ctx).warnings, undefined)
})
