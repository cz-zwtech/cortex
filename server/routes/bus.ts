import { Router } from 'express'
import { getBroker } from '../bus/broker.js'
import { aliasSetFor, presenceStatus, splitHistory } from '../bus/identity.js'
import { onBusMessage } from '../bus/busEvents.js'
import { setAvailable, acceptAssignment, splitMetaId } from '../graph/bus.js'
import { all, get } from '../graph/db.js'
import { pruneStaleSessions, pruneSessionsByMachine } from '../bus/pruneStaleSessions.js'
import { meshEnabled } from '../bus/meshAuth.js'
import { nodeId } from '../bus/meshIdentity.js'
import { getMeshState } from '../bus/meshState.js'
import { meshBindConfig } from '../bus/meshBind.js'
import { meshDirectLinkHint } from '../bus/meshHints.js'
import { wsPeerCount, wsLinks } from '../bus/meshWs.js'

export const busRouter = Router()
const broker = getBroker()

const SSE_PING_MS = 25_000

// POST /api/bus/register {sessionId, title?, autoName?, cwd, machine}
busRouter.post('/register', async (req, res) => {
  try {
    const { sessionId, title, autoName, cwd, machine } = req.body ?? {}
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' })
    const presence = await broker.register({ sessionId, title, autoName, cwd: cwd ?? '', machine: machine ?? '' })
    res.json({ presence })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/bus/heartbeat {sessionId}
busRouter.post('/heartbeat', async (req, res) => {
  try {
    await broker.heartbeat(String(req.body?.sessionId ?? ''))
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/bus/touch {sessionId, cwd?, machine?, cadenceS?} — self-healing heartbeat (revives signed_off).
// cadenceS is the watcher's bounded heartbeat interval (seconds); omitted on the
// per-prompt pause-context touch, which must NOT clobber an existing cadence_s.
busRouter.post('/touch', async (req, res) => {
  try {
    const { sessionId, cwd, machine, cadenceS } = req.body ?? {}
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' })
    const cadence = typeof cadenceS === 'number' && Number.isFinite(cadenceS) ? cadenceS : undefined
    await broker.touch(String(sessionId), cwd ? String(cwd) : undefined, machine ? String(machine) : undefined, cadence)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/bus/signoff {sessionId}
busRouter.post('/signoff', async (req, res) => {
  try {
    await broker.signoff(String(req.body?.sessionId ?? ''))
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ── mandate-in-presence (Item 1) — local presence self-stamp ──────────────────

// POST /api/bus/available {sessionId} — opt into the orchestration pool (the
// /cortex-available green-light). Default-out: a session is not assignable until it
// opts in. Clears any prior mandate + anchor.
busRouter.post('/available', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId ?? '')
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' })
    const presence = await setAvailable(sessionId)
    if (!presence) return res.status(404).json({ error: 'session not registered' })
    res.json({ presence })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/bus/done {sessionId} — release an assignment, back to available.
// Same operation as /available (clears mandate + anchor); a distinct verb for CLI
// ergonomics ("I finished this assignment" vs "I'm entering the pool").
busRouter.post('/done', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId ?? '')
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' })
    const presence = await setAvailable(sessionId)
    if (!presence) return res.status(404).json({ error: 'session not registered' })
    res.json({ presence })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/bus/accept {sessionId, msgId, mandate?} — self-stamp an assignment on
// pickup: availability=assigned + mandate (explicit override, else derived from
// the dispatch body) + provenance anchor (assigner metaId + dispatch msgId).
busRouter.post('/accept', async (req, res) => {
  try {
    const { sessionId, msgId, mandate } = req.body ?? {}
    if (!sessionId || !msgId) return res.status(400).json({ error: 'sessionId, msgId required' })
    const presence = await acceptAssignment(
      String(sessionId),
      String(msgId),
      mandate != null ? String(mandate) : undefined,
    )
    if (!presence) return res.status(404).json({ error: 'session or message not found' })
    res.json({ presence })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/bus/send {fromSession, fromName, to, kind?, ref?, body, origTo?}
busRouter.post('/send', async (req, res) => {
  try {
    const { fromSession, fromName, to, kind, ref, body, origTo, humanProvenance } = req.body ?? {}
    if (!fromSession || !to || !body) {
      return res.status(400).json({ error: 'fromSession, to, body required' })
    }
    const result = await broker.send({
      fromSession,
      fromName: fromName ?? '',
      to,
      kind: kind ?? 'msg',
      ref: ref ?? '',
      body,
      origTo: origTo ?? '',
      // honor-system marker: a human directed this send (only meaningful on a
      // trusted source at the receiver). Coerced to a strict boolean.
      humanProvenance: humanProvenance === true || humanProvenance === 1 || humanProvenance === '1',
    })
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/bus/inbox?session=<id>&undeliveredOnly=1
busRouter.get('/inbox', async (req, res) => {
  try {
    const session = String(req.query.session ?? '')
    if (!session) return res.status(400).json({ error: 'session required' })
    const undeliveredOnly = req.query.undeliveredOnly === '1'
    const messages = await broker.inbox(session, { undeliveredOnly })
    res.json({ messages })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/bus/delivered {sessionId, ids:[]}
busRouter.post('/delivered', async (req, res) => {
  try {
    const { sessionId, ids } = req.body ?? {}
    await broker.markDelivered(String(sessionId ?? ''), Array.isArray(ids) ? ids : [])
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/bus/ack {sessionId, id, kind?}
busRouter.post('/ack', async (req, res) => {
  try {
    const { sessionId, id, kind } = req.body ?? {}
    if (!sessionId || !id) return res.status(400).json({ error: 'sessionId, id required' })
    await broker.ack(sessionId, id, kind === 'done' ? 'done' : 'ack')
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/bus/peers — presence with age-derived status
busRouter.get('/peers', async (_req, res) => {
  try {
    const now = Date.now()
    const peers = (await broker.peers()).map((p) => ({
      ...p,
      status: presenceStatus({ lastSeen: p.lastSeen, rawStatus: p.rawStatus }, now),
    }))
    res.json({ peers })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/bus/prune-sessions — on-demand prune of stale presence rows.
// Without a body: TTL-based prune (signed_off >24h, any status >30d). Reversible.
// With { machine } body: purge ALL rows for that machine (test-pollution cleanup).
//   Returns { machine, deleted } when machine is present, else { pruned }.
busRouter.post('/prune-sessions', (req, res) => {
  try {
    const { machine } = (req.body ?? {}) as { machine?: string }
    if (typeof machine === 'string') {
      const result = pruneSessionsByMachine(machine)
      res.json(result)
    } else {
      const pruned = pruneStaleSessions()
      res.json({ pruned })
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/bus/split-meta — backfill: split a collided metaId so each sharer
// owns its own identity (mint-for-all; pass `keep` to retain it on one session).
// Repairs LEGACY collisions — the claimMetaId fix prevents new ones. UPDATEs via
// the single writer, never deletes. Take an online .backup first: messages still
// addressed to the old metaId orphan after the split (senders re-address).
busRouter.post('/split-meta', (req, res) => {
  try {
    const { metaId, keep } = (req.body ?? {}) as { metaId?: string; keep?: string }
    if (typeof metaId !== 'string' || !metaId.trim()) {
      res.status(400).json({ error: 'metaId required' })
      return
    }
    const result = splitMetaId(metaId, typeof keep === 'string' && keep.trim() ? keep : undefined)
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * Resolve a session's alias set the same way `inbox()` does — read its
 * session_meta row and fold in sessionId, metaId, friendly name, and every
 * retired name. A message whose `to` is in this set is for this session.
 */
function aliasSetForSession(session: string): Set<string> {
  const sRow = get<{ fname?: string; meta_id?: string; name_history?: string }>(
    `SELECT friendly_name AS fname, meta_id, name_history FROM session_meta WHERE id = ?`,
    session,
  )
  return aliasSetFor({
    sessionId: session,
    metaId: sRow?.meta_id,
    friendlyName: sRow?.fname,
    nameHistory: splitHistory(sRow?.name_history ?? ''),
  })
}

// GET /api/bus/stream?session=<id> — SSE push of new messages for this session.
//
// Subscribes to the in-process busEvents emitter (fired by sendMessage +
// ingestMeshMessage) and streams any row addressed to one of this session's
// aliases that it did NOT itself send. This is the real-time complement to the
// poll loop: a message surfaces to the watcher instantly instead of on its next
// tick. The poll stays as a safety net. The alias set is resolved once at
// connect; a rename is rare and the poll fallback covers the gap.
busRouter.get('/stream', (req, res) => {
  const session = String(req.query.session ?? '')
  if (!session) {
    res.status(400).json({ error: 'session required' })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.flushHeaders?.()
  res.write(': connected\n\n')

  const aliasSet = aliasSetForSession(session)
  const unsubscribe = onBusMessage((row) => {
    // Only rows addressed to one of my aliases, and never my own sends.
    if (row.fromSession === session) return
    if (!aliasSet.has(row.to)) return
    try {
      res.write(`data: ${JSON.stringify(row)}\n\n`)
    } catch {
      /* peer gone — the 'close' handler will tear down */
    }
  })

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      /* ignore — teardown on close */
    }
  }, SSE_PING_MS)
  ping.unref?.()

  req.on('close', () => {
    clearInterval(ping)
    unsubscribe()
  })
})

// GET /api/bus/mesh-status — mesh diagnostics (NOT token-gated; local read).
// Reads the in-process mesh view + the persisted per-peer cursors for the
// `ckn-bus mesh` subcommand (m2m-gate diagnostics).
busRouter.get('/mesh-status', (_req, res) => {
  try {
    const mesh = getMeshState()
    const peers = mesh.allPeers().map((p) => ({
      url: p.url,
      nodeId: p.nodeId ?? '',
      reachable: p.reachable,
      zombie: p.zombie,
      sessionCount: p.sessionCount,
      lastGossipAt: p.lastGossipAt,
      // L2 per-edge dial verdict (unknown|reachable|reception-only|unreachable).
      capability: p.capability,
    }))
    const cursors = all<{ peer_node: string; last_seq: number; updated_at: number }>(
      `SELECT peer_node, last_seq, updated_at FROM mesh_cursors ORDER BY peer_node ASC`,
    ).map((c) => ({ peerNode: c.peer_node, lastSeq: c.last_seq, updatedAt: c.updated_at }))
    // FR-7 I5 — direct-link diagnostics: a loopback-only node (no published
    // CKN_MESH_BIND) with unreachable peers can only relay; suggest WSL mirrored
    // networking + a published bind for a DIRECT link. Advisory (relay is a valid fallback).
    const hint = meshDirectLinkHint({ bindConfigured: meshBindConfig() != null, peers })
    res.json({
      enabled: meshEnabled(),
      nodeId: nodeId(),
      peers,
      cursors,
      wsPeers: wsPeerCount(),
      wsLinks: wsLinks(),
      hints: hint ? [hint] : [],
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})
