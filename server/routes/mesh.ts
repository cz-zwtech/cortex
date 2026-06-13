/**
 * Proof-gated `/api/mesh/*` ingress — the receiving side of the push-replicate
 * mesh. Every route sits behind `meshAuthMiddleware` (a per-request HMAC proof of
 * fleet-token possession — the token is NEVER transmitted; slice #4B): an
 * unauthenticated peer must never be able to spoof `fromSession` or read our
 * originated history.
 *
 *   POST /ingest  — a peer broadcasts a full wire message → upsert-with-union
 *                   into our local store (idempotent, conflict-free).
 *   POST /state   — a delivered/ack broadcast → union the grow-only sets only.
 *   POST /gossip  — bidirectional presence exchange: merge the peer's snapshot,
 *                   mark it reachable, and reply with OUR live local presences in
 *                   one round trip.
 *   GET  /since   — catch-up source: the messages WE originated past the caller's
 *                   cursor, in seq order, each carrying current delivered/ack/status.
 *
 * Error handling mirrors routes/bus.ts: try/catch → 500 {error}; 400 on missing
 * required fields. Reads/writes are synchronous (better-sqlite3) so the handlers
 * are plain (no await) but kept async-shaped for symmetry with the bus routes.
 */
import { Router } from 'express'
import type { SessionPresence } from '../graph/_rows.js'
import {
  ingestMeshMessage,
  applyMeshState,
  messagesOriginatedSince,
  listPeers,
  type MeshMessage,
} from '../graph/bus.js'
import { nodeId } from '../bus/meshIdentity.js'
import { meshAuthMiddleware } from '../bus/meshAuth.js'
import { getMeshState } from '../bus/meshState.js'
import { presenceStatus } from '../bus/identity.js'

export const meshRouter = Router()

// Single gate for the whole tier — every /api/mesh/* route requires a valid
// per-request HMAC proof (no bearer; the token never goes on the wire).
meshRouter.use(meshAuthMiddleware)

/**
 * Resolve a sender node id to its registered peer url so we can stamp activity
 * against the right PeerState. Best-effort: a sender we don't have in our seed
 * list (asymmetric config) simply doesn't get an activity bump — harmless.
 */
function peerUrlForNode(node: string): string | undefined {
  if (!node) return undefined
  return getMeshState()
    .allPeers()
    .find((p) => p.nodeId === node)?.url
}

/** Bump the sender peer's activity clock (clears a zombie verdict) when resolvable. */
function recordSenderActivity(node: string, now: number): void {
  const url = peerUrlForNode(node)
  if (url) getMeshState().recordActivity(url, now)
}

// POST /api/mesh/ingest — a fully-stamped wire message from a peer.
meshRouter.post('/ingest', async (req, res) => {
  try {
    const msg = req.body as Partial<MeshMessage> | undefined
    if (!msg || !msg.id) return res.status(400).json({ error: 'id required' })
    ingestMeshMessage(msg as MeshMessage)
    recordSenderActivity(String(msg.originNode ?? ''), Date.now())
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/mesh/state — a delivered/ack broadcast for an already-known message.
meshRouter.post('/state', async (req, res) => {
  try {
    const { id, deliveredTo, ackedBy, status, node } = req.body ?? {}
    if (!id) return res.status(400).json({ error: 'id required' })
    applyMeshState(
      String(id),
      Array.isArray(deliveredTo) ? deliveredTo : [],
      Array.isArray(ackedBy) ? ackedBy : [],
      status ? String(status) : undefined,
      node ? String(node) : undefined,
    )
    recordSenderActivity(String(node ?? ''), Date.now())
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/mesh/gossip {node, sessions} — bidirectional presence exchange.
meshRouter.post('/gossip', async (req, res) => {
  try {
    const now = Date.now()
    const node = String(req.body?.node ?? '')
    const sessions = Array.isArray(req.body?.sessions) ? (req.body.sessions as SessionPresence[]) : []
    if (!node) return res.status(400).json({ error: 'node required' })

    const mesh = getMeshState()
    mesh.mergeGossip(node, sessions, now)
    const url = peerUrlForNode(node)
    if (url) {
      mesh.markReachable(url, node, sessions.length, now)
      if (sessions.length) mesh.recordActivity(url, now)
    }

    // Reply with OUR live/idle local presences so one round trip refreshes both
    // directions. Filter to actually-present sessions (signed_off/stale excluded).
    const ours = (await listPeers()).filter((p) => {
      const s = presenceStatus({ lastSeen: p.lastSeen, rawStatus: p.rawStatus }, now)
      return s === 'live' || s === 'idle'
    })
    res.json({ node: nodeId(), sessions: ours })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/mesh/since?after=<seq> — catch-up source for a recovering peer.
meshRouter.get('/since', async (req, res) => {
  try {
    const after = Number(req.query.after ?? 0)
    const messages = messagesOriginatedSince(Number.isFinite(after) ? after : 0)
    res.json({ messages })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})
