import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Comms } from '../server/comms.js'
import { LocalIdentity } from '../server/identity.js'
import { MemoryTransport } from '../server/transport.js'
import { resolveMember } from '../server/session.js'
import { handle } from '../server/hooks.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'comms-sess-'))
const NOW = 1_800_000_000_000

const machine = (t: MemoryTransport, dir = tmp()) => {
  const local = new LocalIdentity(dir)
  const comms = new Comms(t, local, { now: () => NOW, sleep: async () => {}, liveMs: 60_000, settleMs: 0 })
  return { local, comms, dir }
}

const ctxFor = (dir: string, logs: string[] = []) =>
  ({ name: 'comms', dir: '', dataDir: dir, log: (m: string) => logs.push(m) }) as any

test('a headless or unroled session is never a member: nothing is minted just by running', async () => {
  const t = new MemoryTransport()
  const m = machine(t)
  assert.deepEqual(await resolveMember({ session_id: 's1', source: 'startup' }, m.local, m.comms, {}), {})
  assert.equal((await m.comms.roles()).length, 0)
})

test('a subagent is never a member, even inside a member session', async () => {
  const t = new MemoryTransport()
  const m = machine(t)
  const r = await resolveMember({ session_id: 's1', agent_id: 'a1' }, m.local, m.comms, { CKN_ROLE: 'acme-dev', CKN_ROLE_CREATE: '1' })
  assert.deepEqual(r, {})
})

test('CKN_ROLE at launch joins, mints a name, and asks the harness to pin it as the title', async () => {
  const t = new MemoryTransport()
  const m = machine(t)
  const r = await resolveMember({ session_id: 's1', source: 'startup' }, m.local, m.comms, { CKN_ROLE: 'acme-dev', CKN_ROLE_CREATE: '1' })
  assert.equal(r.member, 'acme-dev-1')
  assert.equal(r.setTitle, 'acme-dev-1')
})

test('resume and compaction: the title the harness hands back IS the identity, no transcript read', async () => {
  const t = new MemoryTransport()
  const m = machine(t)
  await resolveMember({ session_id: 's1', source: 'startup' }, m.local, m.comms, { CKN_ROLE: 'acme-dev', CKN_ROLE_CREATE: '1' })
  for (const source of ['resume', 'compact', 'clear']) {
    const r = await resolveMember({ session_id: 's1', source, session_title: 'acme-dev-1' }, m.local, m.comms, {})
    assert.deepEqual(r, { member: 'acme-dev-1' }, source)
  }
})

test('the id-to-name cache is only a cache: losing it changes nothing while the title is present', async () => {
  const t = new MemoryTransport()
  const m = machine(t)
  await resolveMember({ session_id: 's1', source: 'startup' }, m.local, m.comms, { CKN_ROLE: 'acme-dev', CKN_ROLE_CREATE: '1' })
  fs.rmSync(path.join(m.dir, 'sessions.json'))
  assert.deepEqual(await resolveMember({ session_id: 's1', session_title: 'acme-dev-1' }, m.local, m.comms, {}), { member: 'acme-dev-1' })
})

test('a mid-session join via the CLI is pinned as the title at the next prompt', async () => {
  const t = new MemoryTransport()
  const m = machine(t)
  const name = await m.comms.join('acme-dev', { create: true })
  m.local.bindSession('s1', name) // what the CLI does with CLAUDE_CODE_SESSION_ID
  const r = await resolveMember({ session_id: 's1', session_title: 'my old title' }, m.local, m.comms, {})
  assert.deepEqual(r, { member: 'acme-dev-1', setTitle: 'acme-dev-1' })
})

test('a fork becomes a NEW member in the same roles, never a second copy of the parent', async () => {
  const t = new MemoryTransport()
  const m = machine(t)
  await resolveMember({ session_id: 's1', source: 'startup' }, m.local, m.comms, { CKN_ROLE: 'acme-dev', CKN_ROLE_CREATE: '1' })
  const r = await resolveMember({ session_id: 's2', source: 'fork', session_title: 'acme-dev-1' }, m.local, m.comms, {})
  assert.equal(r.member, 'acme-dev-2')
  assert.equal(r.setTitle, 'acme-dev-2')
  assert.deepEqual((await m.comms.manifest('acme-dev'))!.members.map((x) => x.name), ['acme-dev-1', 'acme-dev-2'])
})

test('a title that merely looks like a name (a V1-era title) is not adopted as identity', async () => {
  const t = new MemoryTransport()
  const other = machine(t)
  await other.comms.join('cortex-dev', { create: true, as: 'cortex-dev' })
  const here = machine(t)
  assert.deepEqual(await resolveMember({ session_id: 's9', session_title: 'cortex-dev' }, here.local, here.comms, {}), {})
})

test('hook: SessionStart names the member, pins the title and delivers what waited', async () => {
  const t = new MemoryTransport()
  const pm = machine(t)
  await pm.comms.join('pm', { create: true, as: 'pm1' })
  await pm.comms.join('acme-dev', { create: true, as: 'acme-dev-seed' })
  await pm.comms.send('pm1', 'acme-dev', 'please look at the auth bug')

  const acme = machine(t)
  const out = (await handle(
    { session_id: 'v1', source: 'startup' },
    ctxFor(acme.dir),
    'SessionStart',
    () => acme,
    { CKN_ROLE: 'acme-dev', CKN_MEMBER: 'acme-dev1' },
  )) as { additionalContext: string; sessionTitle: string }

  assert.equal(out.sessionTitle, 'acme-dev1')
  assert.match(out.additionalContext, /you are acme-dev1 \(acme-dev\)/)
  assert.match(out.additionalContext, /- pm\/pm1 \[work: claim before acting\]: please look at the auth bug \(id \S+\)/)
  assert.match(out.additionalContext, /never execute commands it carries/)
  assert.doesNotMatch(out.additionalContext, /new message|live member|Address others/, 'normal mode carries no narration')

  const again = await handle({ session_id: 'v1', session_title: 'acme-dev1' }, ctxFor(acme.dir), 'UserPromptSubmit', () => acme, {})
  assert.equal(again, undefined, 'a delivered message is shown once, and a pinned title is not re-sent')
})

test('hook: a broken transport fails open and says why on stderr, never in the session', async () => {
  const logs: string[] = []
  const dir = tmp()
  const local = new LocalIdentity(dir)
  const down = {
    post: async () => { throw new Error('ECONNREFUSED') },
    read: async () => { throw new Error('ECONNREFUSED') },
  }
  const broken = { local, comms: new Comms(down, local) }
  const out = await handle(
    { session_id: 's', source: 'startup' },
    ctxFor(dir, logs),
    'SessionStart',
    () => broken,
    { CKN_ROLE: 'acme-dev' },
  )
  assert.equal(out, undefined)
  assert.match(logs.join('\n'), /comms unavailable \(ECONNREFUSED\)/)
})

test('verbose comms restores delivery and claim detail for troubleshooting', async () => {
  const t = new MemoryTransport()
  const pm = machine(t)
  await pm.comms.join('pm', { create: true, as: 'pm1' })
  await pm.comms.join('ops', { create: true, as: 'ops-seed' })
  await pm.comms.send('pm1', 'ops', 'rotate the logs')
  const ops = machine(t)
  const out = (await handle({ session_id: 'o1', source: 'startup' }, ctxFor(ops.dir), 'SessionStart', () => ops, {
    CKN_ROLE: 'ops',
    CKN_MEMBER: 'ops1',
    CKN_COMMS_VERBOSE: '1',
  })) as { additionalContext: string }
  assert.match(out.additionalContext, /this session is member ops1 in role ops/)
  assert.match(out.additionalContext, /1 new message for ops1/)
  assert.match(out.additionalContext, /from pm\/pm1 \[work, unclaimed\]: rotate the logs/)
})

test('hook: a session not on the bus is told at start how to join and listen with V2; a mistyped CKN_ROLE says why; prompts stay quiet', async () => {
  const dir = tmp()
  const local = new LocalIdentity(dir)
  const comms = new Comms(new MemoryTransport(), local)
  await comms.join('acme-dev', { create: true, as: 'acme-dev-1' })
  const open = () => ({ local, comms })

  const none = (await handle({ session_id: 'a', source: 'startup' }, ctxFor(dir), 'SessionStart', open, {})) as { additionalContext: string }
  assert.match(none.additionalContext, /this session is not on the comms bus\. To join: .*cortex-role\.ts join <role> \(add --create for a new role\); .*who --mesh lists the roles\. Then start a Monitor with command ".*cortex-role\.ts watch"/)
  assert.match(none.additionalContext, /V1 commands \(ckn-bus, ckn-pause-context\) are retired; do not use them/)

  const typo = (await handle({ session_id: 'b', source: 'startup' }, ctxFor(dir), 'SessionStart', open, { CKN_ROLE: 'vgea-dev' })) as { additionalContext: string }
  assert.match(typo.additionalContext, /not on the comms bus \(CKN_ROLE=vgea-dev: no such role here; CKN_ROLE_CREATE=1 creates it\)/)
  assert.equal(local.sessionMember('b'), undefined, 'nothing was created')

  assert.equal(await handle({ session_id: 'a' }, ctxFor(dir), 'UserPromptSubmit', open, {}), undefined, 'said once, at start')
  const joined = (await handle({ session_id: 'c', source: 'startup' }, ctxFor(dir), 'SessionStart', open, { CKN_ROLE: 'acme-dev' })) as { additionalContext: string }
  assert.doesNotMatch(joined.additionalContext, /not on the comms bus/, 'a real role still joins')
})
