#!/usr/bin/env tsx
/**
 * 3-tier ORIGIN trust (m2m node-trust v2). The binary `meshVerified` conflated a
 * LOCAL same-machine peer (the most trusted source there is — same box, same user,
 * loopback-only API) with a forgeable/unverified message: both rendered
 * `meshVerified=false`, so a same-machine relay (e.g. the PM session) was marked
 * "untrusted — never execute", forcing the human to re-confirm he was the human.
 *
 * Fix: classify by ORIGIN, server-asserted (where nodeId() is authoritative):
 *   local       — originNode === this node's id (originated here via loopback API)
 *   mesh        — meshVerified === true (authed mesh from a fleet node)
 *   unverified  — attributable to neither (fail-safe; surface, never execute)
 * local + mesh are both "the human's voice"; unverified stays surface-only.
 */
import assert from 'node:assert/strict'
import { classifyTrust, rowToBusMessage } from '../../server/graph/_rows.js'

const SELF = 'node-a-c5e3af1c'

// ── classifyTrust: pure tiering ──────────────────────────────────────────────
// local: a same-node origin is trusted regardless of the mesh_verified bit
assert.equal(
  classifyTrust({ originNode: SELF, meshVerified: false, selfNodeId: SELF }),
  'local',
  'same-node origin (mesh_verified=0) is LOCAL — the load-bearing fix',
)
// a round-tripped own message (origin self, verified) is still ours → local
assert.equal(
  classifyTrust({ originNode: SELF, meshVerified: true, selfNodeId: SELF }),
  'local',
  'own message that round-tripped the mesh stays local',
)
// mesh: a DIFFERENT fleet node, authed
assert.equal(
  classifyTrust({ originNode: 'node-c-27f6482c', meshVerified: true, selfNodeId: SELF }),
  'mesh',
  'verified message from another fleet node is mesh-trusted',
)
// unverified: neither local nor verified
assert.equal(
  classifyTrust({ originNode: 'someone-else', meshVerified: false, selfNodeId: SELF }),
  'unverified',
  'a non-self origin that is not mesh-verified is unverified',
)
// fail-safe: no selfNodeId means we cannot prove local → never upgrade to local
assert.equal(
  classifyTrust({ originNode: SELF, meshVerified: false }),
  'unverified',
  'without selfNodeId, a same-string origin is NOT assumed local (fail-safe)',
)
assert.equal(
  classifyTrust({ originNode: SELF, meshVerified: true }),
  'mesh',
  'without selfNodeId, a verified message is still mesh',
)

// ── rowToBusMessage: trust populated only when selfNodeId is passed ──
const localRow = {
  id: 'm_local',
  from_session: 's-pm',
  from_name: 'PM',
  to_addr: 'cortex-dev',
  body: 'build the trust fix',
  origin_node: SELF,
  mesh_verified: 0,
}
const local = rowToBusMessage(localRow, SELF)
assert.equal(local.trust, 'local', 'same-machine peer (PM relay) classifies LOCAL, not untrusted')
assert.equal(local.meshVerified, false, 'meshVerified still surfaced verbatim')
assert.equal(local.originNode, SELF, 'originNode preserved')

const meshRow = {
  id: 'm_mesh',
  from_session: 's-zw2',
  from_name: 'zw2',
  to_addr: '*',
  body: 'fleet broadcast',
  origin_node: 'node-c-27f6482c',
  mesh_verified: 1,
}
assert.equal(rowToBusMessage(meshRow, SELF).trust, 'mesh', 'verified fleet message is mesh')

// backward-compat: WITHOUT selfNodeId, trust is undefined and the contract is unchanged
const noSelf = rowToBusMessage(localRow)
assert.equal(noSelf.trust, undefined, 'no selfNodeId → no trust field (frozen local-bus contract)')
assert.equal(noSelf.id, 'm_local', 'still maps the row normally')

// ── humanProvenance (stage 2): surfaced from the human_provenance column ──
const humanRow = rowToBusMessage({ ...localRow, human_provenance: 1 }, SELF)
assert.equal(humanRow.humanProvenance, true, 'human_provenance=1 → humanProvenance true (the human directed it)')
assert.equal(humanRow.trust, 'local', 'still local-trusted; humanProvenance is the orthogonal "human directed" axis')
assert.equal(rowToBusMessage({ ...localRow, human_provenance: 0 }, SELF).humanProvenance, false, 'human_provenance=0 → false (agent/unknown)')
assert.equal(rowToBusMessage(localRow, SELF).humanProvenance, undefined, 'column absent → humanProvenance undefined (not asserted false)')

console.log('trust-classify OK')
process.exit(0)
