/**
 * The periodic mesh gossip loop — the heartbeat that keeps the decentralized
 * fleet view converged WITHOUT a central hub.
 *
 * Each tick, for EVERY seeded peer (reachable or not — we re-probe the dead to
 * detect recovery):
 *   1. POST /api/mesh/gossip {node, sessions:<our live local presences>}.
 *   2. On a successful reply: merge the peer's snapshot into our gossiped view,
 *      mark it reachable. If that was an unreachable→reachable TRANSITION, fire a
 *      catch-up (/since) so any messages it originated while we were partitioned
 *      replay into our local store exactly once (cursor-driven, conflict-free).
 *   3. On failure/timeout: mark it unreachable (its sessions drop from the view;
 *      broadcasts skip it) — the next successful tick triggers recovery catch-up.
 * After the round, `evaluateZombies` retires reachable-but-silent-and-empty peers.
 *
 * Catch-up (`catchUpFrom`) pages `GET /api/mesh/since?after=<cursor>` until a
 * short page drains it, ingesting each message (upsert-with-union) and advancing
 * the per-peer cursor to the max seq seen. Best-effort throughout: a dead peer
 * never throws out of the loop.
 *
 * Started/stopped by server/index.ts when the mesh tier is active (T8 wiring).
 */
import { meshHeaders, meshEnabled, meshToken } from './meshAuth.js'
import { verifyResponse, RESP_SIG_HEADER, SIG_NONCE_HEADER } from './meshProof.js'
import { nodeId } from './meshIdentity.js'
import { getMeshState } from './meshState.js'
import { presenceStatus } from './identity.js'
import {
  listPeers,
  ingestMeshMessage,
  getCursor,
  setCursor,
  type MeshMessage,
  type BusMessageRow,
} from '../graph/bus.js'
import type { SessionPresence } from '../graph/_rows.js'

const DEFAULT_GOSSIP_MS = 20_000
const DEFAULT_ZOMBIE_MS = 600_000
/** Per-call outbound timeout — a slow/dead peer must not stall the round. */
const FETCH_TIMEOUT_MS = 2_000
/** Matches `messagesOriginatedSince`'s server-side page size; a page < this drains. */
const SINCE_PAGE = 500

function gossipMs(): number {
  const raw = Number(process.env.CKN_MESH_GOSSIP_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GOSSIP_MS
}

/**
 * WS transport active? The WS channel (meshWs.ts) is THE mesh transport whenever
 * mesh is enabled (CKN_MESH_TOKEN present — the dial-list model, spec §2): a node
 * always accepts authed inbound WS and dials its CKN_MESH_PEERS. So gossip/messages/
 * state ride the persistent WS frames, and the HTTP outbound paths (this loop + the
 * MeshBroker broadcast) are NO-OPs to avoid the double-send. Derived from
 * `meshEnabled()`, NOT a separate role flag (which the wiring never set — the prior
 * bug that left HTTP running on top of WS). The HTTP loop/broker broadcast remain
 * only for a hypothetical future legacy pure-HTTP fleet (mesh enabled by some other
 * means with WS off), not reachable in the current build.
 */
export function wsMode(): boolean {
  return meshEnabled()
}

function zombieMs(): number {
  const raw = Number(process.env.CKN_MESH_ZOMBIE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ZOMBIE_MS
}

let timer: ReturnType<typeof setInterval> | null = null

/** Our live/idle local presences — the snapshot we gossip out (mirrors routes/mesh.ts). */
async function localPresences(now: number): Promise<SessionPresence[]> {
  return (await listPeers()).filter((p) => {
    const s = presenceStatus({ lastSeen: p.lastSeen, rawStatus: p.rawStatus }, now)
    return s === 'live' || s === 'idle'
  })
}

/** Best-effort outbound JSON call with a ~2s abort timeout. Returns parsed body or null. */
async function call(
  url: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<any | null> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const bodyStr = init.body === undefined ? '' : JSON.stringify(init.body)
    const headers = meshHeaders(init.method, path, bodyStr)
    const res = await fetch(`${url}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : bodyStr,
      signal: controller.signal,
    })
    if (!res.ok) return null
    // MUTUAL: the peer must prove it holds the fleet token over OUR nonce before we
    // trust the body — else a spoofed peer-addr could feed forged presence/messages.
    if (!verifyResponse(meshToken(), headers[SIG_NONCE_HEADER] ?? '', res.headers.get(RESP_SIG_HEADER) ?? '')) {
      return null
    }
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/**
 * Drain a recovered peer's originated history into our local store. Pages
 * `/since?after=<cursor>` from the per-peer cursor, ingests each message
 * (idempotent upsert-with-union), and advances the cursor to the max seq seen,
 * repeating until a short page signals drained. Best-effort — a mid-drain failure
 * just leaves the cursor where it got to; the next recovery resumes from there.
 */
export async function catchUpFrom(url: string, peerNode: string): Promise<void> {
  if (!peerNode) return
  for (;;) {
    const after = getCursor(peerNode)
    const reply = await call(url, `/api/mesh/since?after=${after}`, { method: 'GET' })
    const messages: BusMessageRow[] = Array.isArray(reply?.messages) ? reply.messages : []
    if (messages.length === 0) return
    let maxSeq = after
    for (const m of messages) {
      ingestMeshMessage(m as unknown as MeshMessage)
      const seq = Number(m.meshSeq ?? 0)
      if (seq > maxSeq) maxSeq = seq
    }
    if (maxSeq > after) setCursor(peerNode, maxSeq)
    // A short page (or no forward progress) means we've drained the peer.
    if (messages.length < SINCE_PAGE || maxSeq <= after) return
  }
}

/**
 * One gossip exchange with a single peer. Sends our snapshot; on a reply, merges
 * theirs + marks reachable; on an unreachable→reachable transition, fires catch-up
 * (so a peer that was offline re-syncs its originated messages exactly once).
 */
async function gossipPeer(url: string, mySessions: SessionPresence[], now: number): Promise<void> {
  const mesh = getMeshState()
  const reply = await call(url, '/api/mesh/gossip', {
    method: 'POST',
    body: { node: nodeId(), sessions: mySessions },
  })
  if (!reply || typeof reply.node !== 'string' || !reply.node) {
    mesh.markUnreachable(url, now)
    return
  }
  const sessions: SessionPresence[] = Array.isArray(reply.sessions) ? reply.sessions : []
  mesh.mergeGossip(reply.node, sessions, now)
  const transition = mesh.markReachable(url, reply.node, sessions.length, now)
  if (transition) await catchUpFrom(url, reply.node)
}

/** One full round: gossip every seeded peer, then sweep for zombies. */
async function tick(): Promise<void> {
  const now = Date.now()
  const mesh = getMeshState()
  const mySessions = await localPresences(now)
  await Promise.all(mesh.peerUrls().map((url) => gossipPeer(url, mySessions, now)))
  mesh.evaluateZombies(Date.now(), zombieMs())
}

/**
 * Start the periodic gossip loop. Idempotent (a second call is a no-op). The
 * interval is `.unref()`'d so it never keeps the process alive on its own. Runs
 * an initial gossip+catch-up round immediately on activation so the fleet view +
 * any offline-gap reconciliation happen at boot, not after the first interval.
 *
 * NO-OP in WS mode: when WS transport is active, presence gossip rides the WS
 * `gossip` frames (meshWs.ts), so the HTTP outbound loop would only double the
 * traffic. A passive node in particular must open NO outbound at all — and this
 * loop is the only thing that would dial out from one. The loop is kept solely
 * for a future pure-HTTP (no WS) fleet.
 */
export function startMeshGossip(): void {
  if (wsMode()) return
  if (timer) return
  timer = setInterval(() => {
    void tick()
  }, gossipMs())
  timer.unref()
  void tick()
}

/** Stop the loop. Idempotent. */
export function stopMeshGossip(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

/** Test seam: run one round synchronously-awaitable (no interval involved). */
export async function _gossipOnce(): Promise<void> {
  await tick()
}
