#!/usr/bin/env tsx
/**
 * resolveRecipient send-side name resolution — the residual gap after the
 * session-identity fix. A signed_off/stale row that still wears a friendly name
 * (e.g. a reaped phantom) must NOT count as an addressable candidate or fabricate
 * false ambiguity ("'cortex-dev' is ambiguous (2 live sessions): real / phantom").
 * Only live/idle rows are addressable; among live same-machine ties the
 * transcript-backed row wins.
 */
import assert from 'node:assert/strict'
import { resolveRecipient, type Peer } from '../../bin/_resolve-recipient.ts'

const HOST = 'node-a-c5e3af1c'
const peer = (o: Partial<Peer> & { sessionId: string; status: string }): Peer => ({
  friendlyName: 'cortex-dev',
  machine: HOST,
  cwd: '/path/to/repos',
  nameHistory: [],
  ...o,
})
const THROW = (m: string): never => { throw new Error(m) }

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. THE PM CASE: live + signed_off phantom share the name → resolve to live
{
  const peers = [
    peer({ sessionId: 'real', status: 'live' }),
    peer({ sessionId: 'phantom', status: 'signed_off' }),
  ]
  const to = resolveRecipient('cortex-dev', peers, HOST, { die: THROW })
  assert.equal(to, 'real', 'a signed_off phantom is not a candidate; resolves to the live row unambiguously')
  ok('live + signed_off same-name → the live row, no false ambiguity')
}

// ── 2. all matching rows are dead → return the literal (probe/marco-polo surfaces it)
{
  const peers = [
    peer({ sessionId: 'p1', status: 'signed_off' }),
    peer({ sessionId: 'p2', status: 'stale' }),
  ]
  const to = resolveRecipient('cortex-dev', peers, HOST, { die: THROW })
  assert.equal(to, 'cortex-dev', 'name known but no live bearer → ride the stream as the literal name')
  ok('signed_off/stale-only → literal name (no die)')
}

// ── 3. two LIVE same-machine ties → the transcript-backed row wins
{
  const peers = [
    peer({ sessionId: 'A', status: 'live' }),
    peer({ sessionId: 'B', status: 'live' }),
  ]
  const to = resolveRecipient('cortex-dev', peers, HOST, {
    die: THROW,
    isLocalTranscript: (id) => id === 'A',
  })
  assert.equal(to, 'A', 'transcript-backed row wins a live same-machine tie')
  ok('live tie broken by transcript-backed row')
}

// ── 4. two LIVE ties, none transcript-backed → genuinely ambiguous (die)
{
  const peers = [
    peer({ sessionId: 'A', status: 'live' }),
    peer({ sessionId: 'B', status: 'live' }),
  ]
  assert.throws(
    () => resolveRecipient('cortex-dev', peers, HOST, { die: THROW, isLocalTranscript: () => false }),
    /ambiguous/,
    'no transcript-backed winner → still ambiguous',
  )
  ok('live tie with no transcript winner → ambiguous (die)')
}

// ── 5. stale is excluded too: live + stale → the live one
{
  const peers = [
    peer({ sessionId: 'real', status: 'live' }),
    peer({ sessionId: 'old', status: 'stale' }),
  ]
  assert.equal(resolveRecipient('cortex-dev', peers, HOST, { die: THROW }), 'real', 'stale excluded')
  ok('stale row excluded from candidates')
}

// ── 6. passthroughs: exact session id, and an unknown name
{
  const peers = [peer({ sessionId: 'real', status: 'live' })]
  assert.equal(resolveRecipient('real', peers, HOST, { die: THROW }), 'real', 'exact session id passes through')
  assert.equal(resolveRecipient('nobody', peers, HOST, { die: THROW }), 'nobody', 'unknown name rides as literal')
  ok('exact id + unknown name passthroughs intact')
}

console.log(`\nOK resolve-recipient.test.ts — ${passed} assertions passed`)
