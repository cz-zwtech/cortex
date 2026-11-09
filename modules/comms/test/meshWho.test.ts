import assert from 'node:assert/strict'
import { test } from 'node:test'

import { meshRoleLine, meshRoles } from '../server/meshWho.js'

const view = {
  self: { node: 'node-a-id', alias: 'node-a' },
  nodes: [
    { node: 'node-b-id', alias: 'node-b', reachable: true, roles: [{ role: 'pm', members: [{ name: 'pm', live: true as const }] }] },
    { node: 'lap-id', alias: 'laptop', reachable: false, roles: [{ role: 'canary', members: [{ name: 'canary-1', live: true as const }] }] },
    { node: 'old-id', reachable: false, expired: true, offlineSince: 1, roles: [{ role: 'gone', members: [{ name: 'gone-1' }] }] },
    { node: 'noalias-id', reachable: true, roles: [{ role: 'ops', members: [{ name: 'ops-1' }] }] },
  ],
}

test('meshRoles lists this node and every known node, addressed by alias, never an expired one', () => {
  const rows = meshRoles(view, [{ role: 'notify', members: [{ name: 'notify-1' }] }])
  assert.deepEqual(rows.map((r) => [r.address, r.reachable]), [
    ['laptop:canary', false],
    ['node-a:notify', true],
    ['noalias-id:ops', true],
    ['node-b:pm', true],
  ])
})

test('--live drops unreachable roles and roles where nobody is live', () => {
  assert.deepEqual(meshRoles(view, [{ role: 'notify', members: [{ name: 'notify-1' }] }], { live: true }).map((r) => r.address), ['node-b:pm'])
})

test('a member is live only when its announcement says so', () => {
  const pm = meshRoles(view, []).find((r) => r.role === 'pm')!
  assert.deepEqual(pm.members, [{ name: 'pm', live: true }])
  assert.match(meshRoleLine(pm), /^node-b:pm\s+reachable\s+1\/1 live {2}pm$/)
})
