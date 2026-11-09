import assert from 'node:assert/strict'
import { test } from 'node:test'

import { meshView } from '../../server/mesh/view.js'
import { meshRoles } from '../../server/meshWho.js'
import { commsOn, node, pair, until } from './harness.js'

const nodeAMember = (dir: string) =>
  meshView(dir, 'lap-node').nodes.find((n) => n.alias === 'node-a')?.roles.find((r) => r.role === 'web-dev')?.members.find((m) => m.name === 'web-dev-1')

test('announcements carry member liveness, and it follows the member: live, lapsed, live again', async () => {
  // node-a re-reads its roles every 200 ms here (30 s live), so a lapse shows without waiting.
  const nodeA = await node('node-a-node', { comms: true, alias: 'node-a', rolesRecheckMs: 200 })
  const lap = await node('lap-node', { comms: true, alias: 'laptop', peers: [nodeA.url] })
  const z = commsOn(nodeA, 'node-a-node')
  await z.join('web-dev', { create: true, as: 'web-dev-1' })
  await commsOn(lap, 'lap-node').join('pm', { create: true, as: 'pm-1' })
  await until('the laptop sees web-dev-1 on node-a live (it just joined, which beats)', () => nodeAMember(lap.dir)?.live === true)
  const prev = process.env.CKN_COMMS_LIVE_MS
  process.env.CKN_COMMS_LIVE_MS = '1'
  try {
    await until('... and not live once its beat is older than the window', () => nodeAMember(lap.dir) !== undefined && nodeAMember(lap.dir)!.live !== true)
  } finally {
    if (prev === undefined) delete process.env.CKN_COMMS_LIVE_MS
    else process.env.CKN_COMMS_LIVE_MS = prev
  }
  await z.beat('web-dev-1')
  await until('... and live again after a beat', () => nodeAMember(lap.dir)?.live === true)
})

test('who --mesh: every role with its address; --live keeps reachable roles with a live member', async () => {
  const { lap } = await pair()
  await until('node-a web-dev-1 live', () => nodeAMember(lap.dir)?.live === true)
  const view = meshView(lap.dir, 'lap-node')
  const local = [{ role: 'pm', members: [{ name: 'pm-1' }] }, { role: 'notify', members: [{ name: 'notify-1', live: true as const }] }]
  const all = meshRoles(view, local)
  assert.deepEqual(all.map((r) => r.address), ['laptop:notify', 'laptop:pm', 'node-a:web-dev'])
  assert.deepEqual(all.find((r) => r.role === 'web-dev')!.members, [{ name: 'web-dev-1', live: true }])
  assert.deepEqual(meshRoles(view, local, { live: true }).map((r) => r.address), ['laptop:notify', 'node-a:web-dev'])
})
