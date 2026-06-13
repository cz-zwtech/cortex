/**
 * Composite broker (Phase B2): fans every bus operation across a LOCAL
 * MessageBroker (the SQLite GraphBroker — always the substrate for this machine's
 * own sessions) and a REMOTE MessageBroker (the additive cross-machine tier;
 * v1 = MeshBroker).
 *
 * Contract: the local side is the source of truth and is always awaited; the
 * remote side is strictly best-effort. A remote failure (peer down, network
 * blip) NEVER throws to the caller and NEVER blocks local behavior — so a
 * machine whose peers vanished mid-session degrades to pure-local silently.
 *
 * Return shapes are byte-identical across the two sides (any remote tier mirrors
 * GraphBroker's SessionPresence / BusMessageRow), so callers stay
 * transport-agnostic. Dedup across the two sides happens on read by message id
 * (inbox) and sessionId (peers).
 */
import type { MessageBroker } from './broker.js'
import type {
  RegisterInput,
  SendInput,
  SessionPresence,
  BusMessageRow,
} from '../graph/bus.js'

/** Swallow a remote-side rejection; log once at warn level, never rethrow. */
async function bestEffort<T>(op: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e: any) {
    console.warn(`[ckn] federated bus: remote ${op} failed (local unaffected):`, e?.message ?? e)
    return undefined
  }
}

export class FederatedBroker implements MessageBroker {
  constructor(
    private readonly local: MessageBroker,
    private readonly remote: MessageBroker,
  ) {}

  // -------------------------------------------------------------------------
  // Presence — local authoritative, remote mirrored best-effort
  // -------------------------------------------------------------------------

  async register(input: RegisterInput): Promise<SessionPresence> {
    const presence = await this.local.register(input)
    // The local tier is authoritative for the durable identity (claimMetaId +
    // name-history fold). Mirror the RESOLVED values to the remote presence so a
    // cross-machine peer addressing this session by metaId or an old name still
    // matches on read.
    await bestEffort('register', () =>
      this.remote.register({
        ...input,
        metaId: presence.metaId,
        nameHistory: presence.nameHistory,
      }),
    )
    return presence
  }

  async heartbeat(sessionId: string): Promise<void> {
    await this.local.heartbeat(sessionId)
    await bestEffort('heartbeat', () => this.remote.heartbeat(sessionId))
  }

  async touch(sessionId: string, cwd?: string, machine?: string, cadenceS?: number): Promise<void> {
    await this.local.touch(sessionId, cwd, machine, cadenceS)
    await bestEffort('touch', () => this.remote.touch(sessionId, cwd, machine, cadenceS))
  }

  async signoff(sessionId: string): Promise<void> {
    await this.local.signoff(sessionId)
    await bestEffort('signoff', () => this.remote.signoff(sessionId))
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /**
   * Always write locally (so same-machine peers + the durable local record
   * work) AND best-effort to the remote stream (so other machines receive).
   * Returns the LOCAL id; dedup on inbox is by message id.
   */
  async send(input: SendInput): Promise<{ id: string }> {
    const result = await this.local.send(input)
    // Reuse the local id for the remote copy so a same-machine peer that reads
    // BOTH tiers' inboxes dedupes them by id (otherwise broadcasts double-deliver).
    await bestEffort('send', () => this.remote.send({ ...input, id: result.id }))
    return result
  }

  /**
   * Merge local + remote inboxes, dedupe by message id (local wins on collision
   * since it carries authoritative delivered/ack CSV state). Remote failure
   * degrades to local-only. Delivery is marked by the caller via markDelivered
   * (which fans out to both sides) — inbox itself is read-only, matching the
   * underlying brokers' semantics so undeliveredOnly stays meaningful.
   */
  async inbox(
    sessionId: string,
    opts: { undeliveredOnly?: boolean } = {},
  ): Promise<BusMessageRow[]> {
    const localRows = await this.local.inbox(sessionId, opts)
    const remoteRows =
      (await bestEffort('inbox', () => this.remote.inbox(sessionId, opts))) ?? []

    const byId = new Map<string, BusMessageRow>()
    for (const m of localRows) byId.set(m.id, m)
    for (const m of remoteRows) if (!byId.has(m.id)) byId.set(m.id, m)

    const rows = Array.from(byId.values())
    rows.sort((a, b) => a.createdAt - b.createdAt)
    return rows
  }

  async markDelivered(sessionId: string, ids: string[]): Promise<void> {
    await this.local.markDelivered(sessionId, ids)
    await bestEffort('markDelivered', () => this.remote.markDelivered(sessionId, ids))
  }

  async ack(sessionId: string, id: string, kind: 'ack' | 'done'): Promise<void> {
    await this.local.ack(sessionId, id, kind)
    await bestEffort('ack', () => this.remote.ack(sessionId, id, kind))
  }

  // -------------------------------------------------------------------------
  // Peers — merge, dedupe by sessionId (local wins)
  // -------------------------------------------------------------------------

  async peers(): Promise<SessionPresence[]> {
    const localPeers = await this.local.peers()
    const remotePeers = (await bestEffort('peers', () => this.remote.peers())) ?? []

    const byId = new Map<string, SessionPresence>()
    for (const p of localPeers) byId.set(p.sessionId, p)
    for (const p of remotePeers) if (!byId.has(p.sessionId)) byId.set(p.sessionId, p)

    const out = Array.from(byId.values())
    out.sort((a, b) => b.lastSeen - a.lastSeen)
    return out
  }
}
