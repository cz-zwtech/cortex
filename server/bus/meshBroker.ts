/**
 * The mesh's REMOTE-tier `MessageBroker`, composed into the FederatedBroker
 * (local-authoritative + remote-best-effort). It replaces RedisBroker as the one
 * cross-machine transport — but the model is fundamentally different:
 * push-replicate, not hub-pull.
 *
 *   - `send` broadcasts the just-written local row to every reachable peer's
 *     `/api/mesh/ingest`; each peer applies it (upsert-with-union) into its OWN
 *     local store, so that peer's sessions read it through the NORMAL local inbox.
 *   - `markDelivered`/`ack` broadcast a state-only delta to `/api/mesh/state`
 *     (grow-only union on the far side).
 *   - reads are LOCAL: `inbox()` returns `[]` (replicated messages already landed
 *     locally) and `peers()` returns the GOSSIPED remote-presence view (the
 *     gossip loop, meshGossip.ts, maintains it).
 *   - presence ops (`register`/`heartbeat`/`touch`/`signoff`) are no-ops here —
 *     presence rides the gossip loop, not per-call writes.
 *
 * Outbound calls are best-effort and NEVER throw: the FederatedBroker already
 * wraps us in `bestEffort`, but we defend anyway (a single dead peer must not
 * sink a fan-out to the others), and a failed call marks the peer unreachable so
 * the gossip loop's recovery path re-syncs it via /since on the next round.
 *
 * WS MODE (M2.1): when the WS transport is active (`wsMode()` —
 * CKN_MESH_INITIATOR or CKN_MESH_PASSIVE set), the HTTP broadcast paths here are
 * BYPASSED. The local tier (GraphBroker) already wrote the row and fired the
 * busEvents that the WS forwarder (meshWs.ts) replicates as `msg`/`state` frames
 * over the persistent links — so an additional HTTP POST would double-send. In
 * WS mode `send`/`ackMessage`/`markDelivered` therefore write-local-only (here:
 * do nothing extra) and the read methods are unchanged. The HTTP broadcast path
 * survives only for a legacy pure-HTTP fleet (neither flag set).
 */
import { meshHeaders, meshToken } from './meshAuth.js'
import { verifyResponse, RESP_SIG_HEADER, SIG_NONCE_HEADER } from './meshProof.js'
import { getMeshState } from './meshState.js'
import { wsMode } from './meshGossip.js'
import { getMessageById } from '../graph/bus.js'
import type { MessageBroker } from './broker.js'
import type {
  RegisterInput,
  SendInput,
  SessionPresence,
  BusMessageRow,
} from '../graph/bus.js'

/** Per-call outbound timeout — a slow/dead peer must not stall the fan-out. */
const FETCH_TIMEOUT_MS = 2_000

export class MeshBroker implements MessageBroker {
  private readonly mesh = getMeshState()

  /**
   * Best-effort outbound POST to `${url}${path}` signed with a per-request HMAC
   * proof (meshHeaders — the token is never sent) + a ~2s AbortController timeout.
   * Returns true on a 2xx whose MUTUAL proof-back verifies; false otherwise. NEVER
   * throws; on any failure (network, timeout, non-2xx, bad proof-back) it marks the
   * peer unreachable so the gossip loop reconciles it via /since when it recovers.
   */
  private async post(url: string, path: string, body: unknown): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const bodyStr = JSON.stringify(body)
      const headers = meshHeaders('POST', path, bodyStr)
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      })
      if (!res.ok) {
        this.mesh.markUnreachable(url, Date.now())
        return false
      }
      // MUTUAL: require the peer's proof-back over our nonce; a spoofed peer that
      // can't sign is treated as unreachable (don't count a forged 2xx as delivered).
      if (!verifyResponse(meshToken(), headers[SIG_NONCE_HEADER] ?? '', res.headers.get(RESP_SIG_HEADER) ?? '')) {
        this.mesh.markUnreachable(url, Date.now())
        return false
      }
      return true
    } catch {
      this.mesh.markUnreachable(url, Date.now())
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** Fan a body out to every current broadcast target. Best-effort, parallel. */
  private async broadcast(path: string, body: unknown): Promise<void> {
    const targets = this.mesh.broadcastTargets()
    await Promise.all(targets.map((url) => this.post(url, path, body)))
  }

  // -------------------------------------------------------------------------
  // Presence — no-ops: the gossip loop owns cross-node presence.
  // -------------------------------------------------------------------------

  async register(input: RegisterInput): Promise<SessionPresence> {
    // The remote tier never owns presence — the FederatedBroker returns the
    // LOCAL register result, so this return value is unused. Shape it anyway.
    return {
      sessionId: input.sessionId,
      friendlyName: '',
      cwd: input.cwd,
      machine: input.machine,
      title: input.title ?? '',
      startedAt: 0,
      lastSeen: 0,
      rawStatus: '',
      supersedes: '',
      metaId: input.metaId ?? '',
      nameHistory: input.nameHistory ?? [],
      cadenceS: 0,
      availability: '',
      mandate: '',
      assignedBy: '',
      assignedRef: '',
    }
  }

  async heartbeat(_sessionId: string): Promise<void> {}
  async touch(_sessionId: string, _cwd?: string, _machine?: string, _cadenceS?: number): Promise<void> {}
  async signoff(_sessionId: string): Promise<void> {}

  // -------------------------------------------------------------------------
  // Messages — broadcast writes to peers' local stores.
  // -------------------------------------------------------------------------

  /**
   * Broadcast a locally-sent message to every peer. The LOCAL tier (GraphBroker)
   * already minted the id, stamped origin_node/mesh_seq, and persisted the row;
   * the FederatedBroker passes us that same id. We read the stamped row back and
   * forward it VERBATIM (peers preserve origin_node/mesh_seq on ingest — they did
   * not originate it), so the /since catch-up cursor for this origin stays
   * consistent with the live broadcast. Returns the same id (no remote minting).
   */
  async send(input: SendInput): Promise<{ id: string }> {
    const id = input.id ?? ''
    // WS mode: the busEvents→WS forwarder already replicated this local-origin
    // row to every connected peer. Write-local-only — no HTTP broadcast.
    if (wsMode()) return { id }
    const row = id ? getMessageById(id) : undefined
    // If the stamped row isn't found (shouldn't happen in the federated path),
    // synthesize the wire from the input so the broadcast still carries content.
    const wire = row
      ? this.toWire(row)
      : {
          id,
          fromSession: input.fromSession,
          fromName: input.fromName,
          to: input.to,
          kind: input.kind,
          ref: input.ref ?? '',
          body: input.body,
          createdAt: Date.now(),
          deliveredTo: [] as string[],
          ackedBy: [] as string[],
          status: 'open',
          origTo: input.origTo ?? '',
          originNode: '',
          meshSeq: 0,
          humanProvenance: input.humanProvenance ?? false,
        }
    await this.broadcast('/api/mesh/ingest', wire)
    return { id }
  }

  async markDelivered(sessionId: string, ids: string[]): Promise<void> {
    if (!sessionId || ids.length === 0) return
    if (wsMode()) return // state delta rides the WS `state` frame; no HTTP POST
    // One state delta per id (the far-side applyMeshState keys by id).
    await Promise.all(
      ids.map((id) =>
        this.broadcast('/api/mesh/state', { id, deliveredTo: [sessionId] }),
      ),
    )
  }

  async ack(sessionId: string, id: string, kind: 'ack' | 'done'): Promise<void> {
    if (!sessionId || !id) return
    if (wsMode()) return // ack rides the WS `state` frame; no HTTP POST
    await this.broadcast('/api/mesh/state', {
      id,
      ackedBy: [sessionId],
      status: kind === 'done' ? 'done' : 'acked',
    })
  }

  // -------------------------------------------------------------------------
  // Reads — local-only (replicated messages already live in the local store).
  // -------------------------------------------------------------------------

  /**
   * Always empty: a mesh-ingested message is written into THIS node's local
   * store, so the FederatedBroker already surfaces it via the local inbox. The
   * remote tier must not re-return it (that would double-deliver / re-surface).
   */
  async inbox(): Promise<BusMessageRow[]> {
    return []
  }

  /** The gossiped remote-presence view (TTL'd + zombie-filtered by MeshState). */
  async peers(): Promise<SessionPresence[]> {
    return this.mesh.gossipedPeers(Date.now())
  }

  /** Map a stored BusMessageRow to the /api/mesh/ingest wire shape (MeshMessage). */
  private toWire(row: BusMessageRow) {
    return {
      id: row.id,
      fromSession: row.fromSession,
      fromName: row.fromName,
      to: row.to,
      kind: row.kind,
      ref: row.ref,
      body: row.body,
      createdAt: row.createdAt,
      deliveredTo: row.deliveredTo,
      ackedBy: row.ackedBy,
      status: row.status,
      origTo: row.origTo,
      originNode: row.originNode ?? '',
      meshSeq: row.meshSeq ?? 0,
      humanProvenance: row.humanProvenance ?? false,
    }
  }
}
