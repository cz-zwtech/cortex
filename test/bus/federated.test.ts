#!/usr/bin/env tsx
/**
 * Offline unit test for the FederatedBroker fan-out contract. NO live peers and
 * NO graph DB required: the LOCAL tier is an in-memory stub (so the test is
 * offline-safe and CI-stable — a real graphBroker would require opening the
 * graph DB, which is single-writer and unavailable here), and the REMOTE tier is
 * a fake `MessageBroker` (post-Redis: the mesh tier is just another
 * MessageBroker) whose every method REJECTS. The assertions prove the
 * load-bearing contract: local operations always succeed and a failing remote
 * NEVER throws to the caller (graceful degradation to local-only).
 */
import assert from 'node:assert/strict'
import { FederatedBroker } from '../../server/bus/federatedBroker.js'
import type { MessageBroker } from '../../server/bus/broker.js'
import type {
  RegisterInput,
  SendInput,
  SessionPresence,
  BusMessageRow,
} from '../../server/graph/bus.js'

// ---------------------------------------------------------------------------
// In-memory LOCAL stub conforming to MessageBroker. Records every call so we
// can assert the local side always ran, regardless of remote failure.
// ---------------------------------------------------------------------------
const calls: string[] = []

const presence = (sessionId: string, lastSeen: number): SessionPresence => ({
  sessionId,
  friendlyName: sessionId.slice(0, 8),
  cwd: '/tmp',
  machine: 'local-m',
  title: '',
  startedAt: lastSeen,
  lastSeen,
  rawStatus: 'live',
  supersedes: '',
  metaId: '',
  nameHistory: [],
})

const msg = (id: string, createdAt: number): BusMessageRow => ({
  id,
  fromSession: 'someone',
  fromName: 'someone',
  to: 'me',
  kind: 'msg',
  ref: '',
  body: `body-${id}`,
  createdAt,
  deliveredTo: [],
  ackedBy: [],
  status: 'open',
  origTo: '',
})

const localStore = {
  inbox: [msg('m_local1', 100), msg('m_shared', 200)],
  peers: [presence('local-sess', 999), presence('shared-sess', 500)],
}

const localStub: MessageBroker = {
  async register(input: RegisterInput) {
    calls.push('local.register')
    return presence(input.sessionId, Date.now())
  },
  async heartbeat() {
    calls.push('local.heartbeat')
  },
  async touch() {
    calls.push('local.touch')
  },
  async signoff() {
    calls.push('local.signoff')
  },
  async send(_input: SendInput) {
    calls.push('local.send')
    return { id: 'm_local_sent' }
  },
  async inbox() {
    calls.push('local.inbox')
    return localStore.inbox.map((m) => ({ ...m }))
  },
  async markDelivered() {
    calls.push('local.markDelivered')
  },
  async ack() {
    calls.push('local.ack')
  },
  async peers() {
    calls.push('local.peers')
    return localStore.peers.map((p) => ({ ...p }))
  },
}

// ---------------------------------------------------------------------------
// REMOTE stub: a fake MessageBroker whose every method rejects. Cast through
// unknown — only the MessageBroker surface is exercised by FederatedBroker.
// ---------------------------------------------------------------------------
const boom = (name: string) => async () => {
  throw new Error(`remote ${name} is down`)
}
const throwingRemote = {
  register: boom('register'),
  heartbeat: boom('heartbeat'),
  touch: boom('touch'),
  signoff: boom('signoff'),
  send: boom('send'),
  inbox: boom('inbox'),
  markDelivered: boom('markDelivered'),
  ack: boom('ack'),
  peers: boom('peers'),
} as unknown as MessageBroker

const fed = new FederatedBroker(localStub, throwingRemote)

// --- presence: local runs, remote failure swallowed ------------------------
const reg = await fed.register({ sessionId: 'sess-1', cwd: '/tmp', machine: 'm' })
assert.equal(reg.sessionId, 'sess-1', 'register returns the LOCAL presence')
await fed.heartbeat('sess-1')
await fed.touch('sess-1', '/tmp', 'm')
await fed.signoff('sess-1')

// --- send: returns the LOCAL id even though remote threw -------------------
const sent = await fed.send({
  fromSession: 'sess-1',
  fromName: 'me',
  to: 'peer',
  kind: 'msg',
  body: 'hi',
})
assert.equal(sent.id, 'm_local_sent', 'send returns the LOCAL message id')

// --- inbox: remote down → local-only rows, deduped by id, sorted -----------
const inbox = await fed.inbox('me')
assert.deepEqual(
  inbox.map((m) => m.id),
  ['m_local1', 'm_shared'],
  'inbox falls back to local rows (ascending createdAt) when remote throws',
)

// --- markDelivered / ack: local runs, remote failure swallowed -------------
await fed.markDelivered('me', ['m_local1'])
await fed.ack('me', 'm_local1', 'ack')

// --- peers: remote down → local-only, deduped by sessionId, sorted desc ----
const peers = await fed.peers()
assert.deepEqual(
  peers.map((p) => p.sessionId),
  ['local-sess', 'shared-sess'],
  'peers falls back to local presence (descending lastSeen) when remote throws',
)

// every local method was invoked despite total remote failure
for (const name of [
  'local.register',
  'local.heartbeat',
  'local.touch',
  'local.signoff',
  'local.send',
  'local.inbox',
  'local.markDelivered',
  'local.ack',
  'local.peers',
]) {
  assert.ok(calls.includes(name), `${name} must have been invoked`)
}

// --- dedup: a remote that RETURNS overlapping rows is deduped (local wins) --
const overlappingRemote = {
  inbox: async (): Promise<BusMessageRow[]> => [
    { ...msg('m_shared', 200), body: 'REMOTE-COPY' }, // collides with local id
    msg('m_remote_only', 300),
  ],
  peers: async (): Promise<SessionPresence[]> => [
    { ...presence('shared-sess', 500), machine: 'REMOTE-COPY' }, // collides
    presence('remote-only-sess', 700),
  ],
  // unused-by-this-block methods still must exist
  register: boom('register'),
  heartbeat: boom('heartbeat'),
  touch: boom('touch'),
  signoff: boom('signoff'),
  send: boom('send'),
  markDelivered: boom('markDelivered'),
  ack: boom('ack'),
} as unknown as MessageBroker

const fed2 = new FederatedBroker(localStub, overlappingRemote)

const mergedInbox = await fed2.inbox('me')
assert.deepEqual(
  mergedInbox.map((m) => m.id),
  ['m_local1', 'm_shared', 'm_remote_only'],
  'inbox merges + dedupes by id, sorted by createdAt',
)
assert.equal(
  mergedInbox.find((m) => m.id === 'm_shared')?.body,
  'body-m_shared',
  'on id collision the LOCAL row wins',
)

const mergedPeers = await fed2.peers()
assert.deepEqual(
  mergedPeers.map((p) => p.sessionId),
  ['local-sess', 'remote-only-sess', 'shared-sess'],
  'peers merges + dedupes by sessionId, sorted by lastSeen desc (local-sess 999 > remote 700 > shared 500)',
)
assert.equal(
  mergedPeers.find((p) => p.sessionId === 'shared-sess')?.machine,
  'local-m',
  'on sessionId collision the LOCAL presence wins',
)

console.log('federated.test.ts: all assertions passed')
