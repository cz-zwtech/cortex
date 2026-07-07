#!/usr/bin/env tsx
/**
 * FR resume-presence S2: `/cortex-rename` (ckn-name-session) must RE-ASSERT the
 * live presence row, not just append a JSONL custom-title. Proves the healing
 * contract against an ephemeral server:
 *   - seed a PRESENTLY HOLLOW (bare-id) presence row (the post-resume state);
 *   - reassertPresence(sid, cwd, title) flips friendly_name to the title — proving
 *     register-with-title OVERRIDES the bare id (the name-floor does NOT help when
 *     the prior name is bare, so this must go through explicitly);
 *   - the healed name SURVIVES a subsequent touch (touchSession never clobbers it).
 */
import assert from 'node:assert/strict'
import { spawnEphemeralServer } from '../_ephemeralServer.js'
import { reassertPresence } from '../../bin/ckn-name-session.js'

const PORT = 3231
const SID = 'rename11-2222-3333-4444-555566667777'
const BARE = SID.slice(0, 8) // 'rename11'
const CWD = '/some/project'

const srv = await spawnEphemeralServer({ port: PORT })
try {
  const post = (p: string, body: unknown) =>
    fetch(`${srv.baseUrl}/api/bus${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const peerName = async (): Promise<string | undefined> => {
    const { peers } = (await (await fetch(`${srv.baseUrl}/api/bus/peers`)).json()) as {
      peers: { sessionId: string; friendlyName: string }[]
    }
    return peers.find((p) => p.sessionId === SID)?.friendlyName
  }

  // Seed a HOLLOW row: a nameless register lands the bare id as friendly_name.
  await post('/register', { sessionId: SID, title: '', cwd: CWD, machine: 'm1' })
  assert.equal(await peerName(), BARE, 'precondition: presence row is bare-id (hollow)')

  // The rename re-assert heals the bare row to the title.
  await reassertPresence(SID, CWD, 'renamed topic', srv.baseUrl)
  assert.equal(
    await peerName(),
    'renamed topic',
    'reassertPresence flips the bare-id row to the new title (register-with-title overrides bare)',
  )

  // A subsequent per-prompt touch must NOT revert the name.
  await post('/touch', { sessionId: SID, cwd: CWD, machine: 'm1' })
  assert.equal(await peerName(), 'renamed topic', 'the healed name SURVIVES a subsequent touch')

  console.log('rename-reasserts-presence OK')
} finally {
  srv.stop()
}
process.exit(0)
