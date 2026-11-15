import assert from 'node:assert/strict'
import { test } from 'node:test'

import { heldOutbound, rolelessHoldNote } from '../../server/mesh/router.js'
import { pair, until } from './harness.js'

// A node with no role is not validated, so its links carry nothing: what it holds must be said, not silent.

test('a node whose last role goes holds its outbound, and says how many wait', async () => {
  const { nodeA, z, l } = await pair()
  await l.send('pm-1', 'node-a:web-dev', 'retire this')
  let n = 0
  await until('delivered on node-a', () => {
    void z.inbox('web-dev-1').then((x) => (n = x.length))
    return n === 1
  })
  assert.equal(heldOutbound(nodeA.log), 0)
  await z.leaveRole('web-dev', 'web-dev-1')
  // Counted at once, before the pump makes the notice an outbox row: that is when leave reports it.
  assert.equal(heldOutbound(nodeA.log), 1)
  // node-a now has no role, so its links carry nothing: the notice stays held once the pump has it too.
  await new Promise((r) => setTimeout(r, 1_000))
  assert.equal(heldOutbound(nodeA.log), 1)
  assert.match(rolelessHoldNote(1), /^1 message\(s\) wait here until this node takes a role again/)
})
