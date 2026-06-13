/**
 * Mesh WebSocket channel (M2.1) — the persistent-link transport for a
 * one-way-initiation deployment. The initiator opens ONE client WS per peer
 * (`connectPeer`); the responder accepts inbound sockets (`acceptPeer`). After
 * connect the protocol is symmetric: both ends send and receive the same frame
 * types over the single connection the initiator dialed, so the responder can
 * PUSH its traffic back across a boundary it cannot itself dial through.
 *
 * Application logic is entirely reused from the M2 HTTP mesh — this file is just
 * the WS wire:
 *   - inbound frames dispatch to `ingestMeshMessage` / `applyMeshState` /
 *     `mergeGossip` / `messagesOriginatedSince` + `getCursor`/`setCursor`.
 *   - outbound: subscribe `onBusMessage`/`onBusState` and forward each as a
 *     `msg`/`state` frame to this peer UNLESS the event is tagged with this
 *     link's `peerNode` (echo-guard — a message replicated FROM peer X is never
 *     forwarded straight back TO X, so no replication loop).
 *
 * Frames (JSON, one per WS message, discriminated by `t`):
 *   hello      {node, cursors, memCursors}      → reply backlog + membacklog
 *   backlog    {messages:[wireMsg…]}            → ingest each + advance our cursor
 *   membacklog {mems:[MeshMemory…]}             → ingest each + advance mem cursor
 *   gossip     {node, sessions:[presence…]}     → mergeGossip + mark reachable
 *   msg        {msg: wireMsg}                    → ingestMeshMessage (union)
 *   mem        {mem: MeshMemory}                 → ingestMeshMemory (grow-only)
 *   state      {id, deliveredTo, ackedBy, status}→ applyMeshState (union)
 */
import { WebSocket } from 'ws'
import { randomBytes } from 'node:crypto'
import { meshToken } from './meshAuth.js'
import { MeshHandshake, type HsFrame } from './meshHandshake.js'
import * as os from 'node:os'
import { nodeId, peerUrls, selfUrl } from './meshIdentity.js'
import { getMachineId } from '../privateMind.js'
import { schedulePersist } from './meshPeerStore.js'
import { getMeshState, type KnownNode } from './meshState.js'
import { classifyAndMaybeDial } from './meshDiscovery.js'
import { presenceStatus } from './identity.js'
import {
  listPeers,
  ingestMeshMessage,
  applyMeshState,
  getCursor,
  setCursor,
  messagesOriginatedSince,
  type MeshMessage,
  type BusMessageRow,
} from '../graph/bus.js'
import { onBusMessage, onBusState, type BusStateEvent } from './busEvents.js'
import {
  ingestMeshMemory,
  onBusMemory,
  getMemCursor,
  setMemCursor,
  memoriesOriginatedSince,
  type MeshMemory,
} from '../graph/memMesh.js'
import type { SessionPresence } from '../graph/_rows.js'

const DEFAULT_GOSSIP_MS = 20_000
/** Reconnect backoff: first delay, multiplier, and cap. */
const BACKOFF_BASE_MS = 500
const BACKOFF_CAP_MS = 30_000
/** Max time for the in-band mutual-auth handshake to complete before the link is
 *  closed (a couple of round-trips; the reconnector re-dials). */
const HANDSHAKE_TIMEOUT_MS = 10_000

function gossipMs(): number {
  const raw = Number(process.env.CKN_MESH_GOSSIP_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GOSSIP_MS
}

// ── frame types ───────────────────────────────────────────────────────────────

interface HelloFrame {
  t: 'hello'
  node: string
  cursors: Record<string, number>
  /** Parallel to `cursors` for the mem-replication tier (M4): OUR per-origin mem
   * cursor map so the peer can backlog-replay only the memories we're missing. */
  memCursors?: Record<string, number>
  /** This node's own advertisable url (CKN_MESH_SELF), so the peer can map our
   * node id ↔ url for reception-only classification. Optional ('' when NAT'd). */
  self?: string
}
interface BacklogFrame {
  t: 'backlog'
  messages: BusMessageRow[]
}
interface MemBacklogFrame {
  t: 'membacklog'
  mems: MeshMemory[]
}
interface GossipFrame {
  t: 'gossip'
  node: string
  sessions: SessionPresence[]
  /** Every peer ADDRESS this node knows about (L2). The receiver learns each NEW
   * address `unknown` + PROBES it (never dials on faith — the per-edge asymmetry).
   * Optional on the wire so an L1 peer's gossip (no addresses) parses fine. */
  addresses?: string[]
  /** This node's own advertisable url (CKN_MESH_SELF) — node id ↔ url mapping. */
  self?: string
  /** This node's CANONICAL machine id — the dedup key for the fleet roster. */
  machineId?: string
  /** Relayed fleet roster (self + every node this one knows), canonical-keyed.
   * Re-advertised each round so the roster propagates multi-hop (full-fleet from
   * any node). Optional on the wire so an older peer's gossip parses fine. */
  nodes?: KnownNode[]
}
interface MsgFrame {
  t: 'msg'
  msg: BusMessageRow
}
interface MemFrame {
  t: 'mem'
  mem: MeshMemory
}
interface StateFrame {
  t: 'state'
  id: string
  deliveredTo: string[]
  ackedBy: string[]
  status: string
}
type Frame =
  | HelloFrame
  | BacklogFrame
  | MemBacklogFrame
  | GossipFrame
  | MsgFrame
  | MemFrame
  | StateFrame
  | HsFrame

// ── presence snapshot we gossip out (mirrors meshGossip.localPresences) ────────

async function localPresences(now: number): Promise<SessionPresence[]> {
  return (await listPeers()).filter((p) => {
    const s = presenceStatus({ lastSeen: p.lastSeen, rawStatus: p.rawStatus }, now)
    return s === 'live' || s === 'idle'
  })
}

/** Coerce a wire BusMessageRow into the MeshMessage shape `ingestMeshMessage`
 * expects (the two are field-compatible; origin_node/mesh_seq ride along). */
function toMeshMessage(m: BusMessageRow): MeshMessage {
  return {
    id: m.id,
    fromSession: m.fromSession,
    fromName: m.fromName,
    to: m.to,
    kind: m.kind,
    ref: m.ref,
    body: m.body,
    createdAt: m.createdAt,
    deliveredTo: m.deliveredTo ?? [],
    ackedBy: m.ackedBy ?? [],
    status: m.status,
    origTo: m.origTo,
    originNode: m.originNode ?? '',
    meshSeq: Number(m.meshSeq ?? 0),
    humanProvenance: m.humanProvenance ?? false,
  }
}

// ── Link — one WebSocket, one peer ──────────────────────────────────────────────

/**
 * A LINK is one live WebSocket to one peer, regardless of who dialed. It owns the
 * frame send/dispatch, the per-link gossip timer, and the bus-event subscriptions
 * that forward local activity to this peer. `peerNode` is learned from the peer's
 * `hello`/`gossip` (a client link doesn't know it until then); it's the echo-guard
 * key — events tagged with `peerNode` are NOT forwarded back to this peer.
 */
class Link {
  readonly ws: WebSocket
  /** Stable registry/diagnostic key: the dial url for a client link, or the
   * accepted socket's remote address for a server link. */
  readonly key: string
  /** True for a client link we DIALED (stable url key; re-dials on drop). False for
   * an accepted inbound link (ephemeral-port key; pruned on close — see teardown). */
  readonly dialed: boolean
  peerNode = ''
  private gossipTimer: ReturnType<typeof setInterval> | null = null
  private unsubMsg: (() => void) | null = null
  private unsubMem: (() => void) | null = null
  private unsubState: (() => void) | null = null
  private opened = false
  private closed = false
  private authed = false
  private hs: MeshHandshake | null = null
  private hsTimer: ReturnType<typeof setTimeout> | null = null

  constructor(ws: WebSocket, key: string, dialed: boolean) {
    this.ws = ws
    this.key = key
    this.dialed = dialed
    ws.on('message', (data) => this.onFrame(data))
    ws.on('close', () => this.teardown())
    ws.on('error', () => {
      // 'close' fires after 'error' for ws; teardown there. Swallow so a dead
      // peer never throws out of the link.
    })
    if (ws.readyState === WebSocket.OPEN) this.onOpen()
    else ws.on('open', () => this.onOpen())
  }

  /** On link open: begin the in-band mutual-auth handshake (slice #4C). The socket
   * opened UNPRIVILEGED — no bus activity is forwarded and no hello/gossip is sent
   * until BOTH sides prove the fleet token. A dialer opens with hs1; a peer waits.
   * A bad proof or a HANDSHAKE_TIMEOUT_MS timeout closes the link. */
  private onOpen(): void {
    if (this.opened || this.closed) return
    this.opened = true

    // A DIALED link reaching OPEN proves this peer is reachable from here — promote
    // its capability so the discovery sweep stops re-probing a live, healthy seed (a
    // transient probe failure must not flip a live-linked peer to 'unreachable').
    if (this.dialed) getMeshState().setCapability(this.key, 'reachable', Date.now())

    this.hs = new MeshHandshake(
      this.dialed ? 'dialer' : 'peer',
      meshToken(),
      randomBytes(16).toString('hex'),
    )
    this.hsTimer = setTimeout(() => {
      if (!this.authed) this.ws.close()
    }, HANDSHAKE_TIMEOUT_MS)
    this.hsTimer.unref()
    const first = this.hs.open()
    if (first) this.send(first)
  }

  /** Both sides proved the fleet token — promote the link to LIVE: subscribe to local
   * bus activity (echo-guarded forward), send our hello (cursors for this peer) + an
   * initial gossip, then gossip on a timer. Until this runs the peer is just an
   * unprivileged socket and NOTHING local is forwarded to it. */
  private onAuthed(): void {
    if (this.closed) return

    this.unsubMsg = onBusMessage((row, fromPeerNode) => {
      if (fromPeerNode && fromPeerNode === this.peerNode) return // echo-guard
      this.send({ t: 'msg', msg: row })
    })
    this.unsubMem = onBusMemory((mem, fromPeerNode) => {
      if (fromPeerNode && fromPeerNode === this.peerNode) return // echo-guard
      this.send({ t: 'mem', mem })
    })
    this.unsubState = onBusState((state: BusStateEvent, fromPeerNode) => {
      if (fromPeerNode && fromPeerNode === this.peerNode) return // echo-guard
      this.send({
        t: 'state',
        id: state.id,
        deliveredTo: state.deliveredTo,
        ackedBy: state.ackedBy,
        status: state.status,
      })
    })

    this.sendHello()
    void this.sendGossip()
    this.gossipTimer = setInterval(() => void this.sendGossip(), gossipMs())
    this.gossipTimer.unref()
  }

  /** hello carries OUR per-peer cursor map so the peer can backlog-replay only
   * what we're missing. Until we've learned `peerNode` the map is just empty —
   * the peer will reply with its own hello and we backlog from that. */
  private sendHello(): void {
    const cursors: Record<string, number> = {}
    const memCursors: Record<string, number> = {}
    if (this.peerNode) {
      cursors[this.peerNode] = getCursor(this.peerNode)
      memCursors[this.peerNode] = getMemCursor(this.peerNode)
    }
    this.send({ t: 'hello', node: nodeId(), cursors, memCursors, self: selfUrl() })
  }

  private async sendGossip(): Promise<void> {
    const now = Date.now()
    // Relay presence like the node roster: our own live/idle sessions PLUS every
    // live/idle remote session we know, so session presence propagates multi-hop
    // (a spoke learns other spokes' sessions through the hub) — router/DNS-style.
    const sessions = getMeshState().presencesForGossip(await localPresences(now), now)
    // Address-list gossip (L2): advertise every address we know so peers can
    // discover the fleet from a single seed. Carries addresses, NOT "dial these"
    // — the receiver probes before it ever dials.
    const addresses = getMeshState().knownAddresses()
    // Fleet roster gossip: advertise self (canonical machineId) + RELAY every
    // node we know, so the roster reaches every node multi-hop and folds to one
    // row per computer regardless of a custom mesh nodeId.
    const nodes = getMeshState().rosterForGossip(
      { nodeId: nodeId(), machineId: getMachineId(), hostname: os.hostname(), url: selfUrl(), lastActivityAt: now },
      now,
    )
    this.send({
      t: 'gossip',
      node: nodeId(),
      sessions,
      addresses,
      self: selfUrl(),
      machineId: getMachineId(),
      nodes,
    })
  }

  send(frame: Frame): void {
    if (this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(frame))
    } catch {
      // best-effort; a failed send drops on the floor (the close handler tears down)
    }
  }

  private onFrame(data: unknown): void {
    let frame: Frame
    try {
      frame = JSON.parse(String(data)) as Frame
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    // Pre-auth: ONLY the in-band handshake is processed; no bus frame is honored
    // until both sides prove the fleet token (slice #4C).
    if (!this.authed) {
      this.onHandshakeFrame(frame as HsFrame)
      return
    }
    switch (frame.t) {
      case 'hello':
        this.onHello(frame)
        break
      case 'backlog':
        this.onBacklog(frame)
        break
      case 'membacklog':
        // async (each ingest is awaited so the mem cursor advances only after the
        // batch is durably applied — see onMemBacklog). Guard the floating promise
        // so a receive-side reject can't become an unhandled rejection (crash).
        void this.onMemBacklog(frame).catch(() => {})
        break
      case 'gossip':
        this.onGossip(frame)
        break
      case 'msg':
        // Pass this link's peer as the LAST HOP so the echo-guard never forwards
        // the frame straight back to it (correct under relay, not just 2-node).
        if (frame.msg) ingestMeshMessage(toMeshMessage(frame.msg), this.peerNode || undefined)
        break
      case 'mem':
        // Same last-hop echo-guard as `msg` — never forward a mem frame straight
        // back to the peer it arrived from (correct under relay, not just 2-node).
        // `ingestMeshMemory` is async and does UNGUARDED I/O (.md write, SQLite
        // write); a transient receive-side reject (ENOSPC/EACCES/DB error) would
        // otherwise become an unhandled rejection and kill the whole Cortex
        // process — which also serves the local-only/mesh-off bus + graph. Swallow
        // it (best-effort, matching this tier's posture); the peer re-floods on its
        // next change and the reconnect cursor only advances on durable apply.
        if (frame.mem) void ingestMeshMemory(frame.mem, this.peerNode || undefined).catch(() => {})
        break
      case 'state':
        applyMeshState(
          frame.id,
          frame.deliveredTo ?? [],
          frame.ackedBy ?? [],
          frame.status,
          this.peerNode || undefined,
        )
        break
    }
  }

  /** Drive the in-band handshake while unauthed: relay the step machine's frames,
   * close on failure, and promote to authed (→ onAuthed) once mutual proof completes.
   * WS preserves frame order, so a dialer's hs3 always lands before its first gossip —
   * the peer authes on hs3 and handles the gossip as an authed link, no race. */
  private onHandshakeFrame(frame: HsFrame): void {
    if (!this.hs) {
      this.ws.close()
      return
    }
    const step = this.hs.onFrame(frame)
    if (step.send) this.send(step.send)
    if (step.fail) {
      this.ws.close()
      return
    }
    if (step.authed) {
      this.authed = true
      if (this.hsTimer) {
        clearTimeout(this.hsTimer)
        this.hsTimer = null
      }
      this.onAuthed()
    }
  }

  /** hello → learn the peer's node id, mark reachable, and reply with the backlog
   * of everything WE originated past the cursor they hold for us. */
  private onHello(frame: HelloFrame): void {
    if (frame.node) this.learnPeer(frame.node)
    if (frame.node && frame.self) getMeshState().recordNodeUrl(frame.node, frame.self)
    const theirCursorForUs = Number(frame.cursors?.[nodeId()] ?? 0)
    const messages = messagesOriginatedSince(theirCursorForUs)
    this.send({ t: 'backlog', messages })
    // Mem tier (M4): reply with the memories WE originated past the mem cursor
    // they hold for us — same hello→backlog reconnect-backfill as the bus tier.
    const theirMemCursorForUs = Number(frame.memCursors?.[nodeId()] ?? 0)
    const mems = memoriesOriginatedSince(theirMemCursorForUs)
    this.send({ t: 'membacklog', mems })
  }

  /** backlog → ingest each (idempotent union) and advance our per-peer cursor to
   * the max seq seen, so a reconnect replays only the still-missing tail. */
  private onBacklog(frame: BacklogFrame): void {
    const messages = Array.isArray(frame.messages) ? frame.messages : []
    if (messages.length === 0) return
    let maxSeq = this.peerNode ? getCursor(this.peerNode) : 0
    for (const m of messages) {
      ingestMeshMessage(toMeshMessage(m), this.peerNode || undefined)
      const seq = Number(m.meshSeq ?? 0)
      if (seq > maxSeq) maxSeq = seq
    }
    if (this.peerNode && maxSeq > 0) setCursor(this.peerNode, maxSeq)
  }

  /** membacklog → ingest each memory (idempotent grow-only apply) and advance our
   * per-peer mem cursor to the max seq seen — mirrors onBacklog for the mem tier.
   *
   * `ingestMeshMemory` is async (it writes the .md + SQLite), so unlike the bus
   * `onBacklog` we must AWAIT each ingest before advancing the cursor: the mem
   * cursor is the reconnect-backfill high-water mark and MUST track *applied*, not
   * *received*, seqs. If we advanced it on fire-and-forget and the server restarted
   * (or an earlier-seq ingest rejected) before the write landed, the next hello
   * would advertise the advanced cursor and the origin would replay only seq > N —
   * permanently skipping the in-flight memory. So: await in seq order, and on the
   * first reject STOP advancing past the last durably-applied seq (the gap replays
   * on the next reconnect). */
  private async onMemBacklog(frame: MemBacklogFrame): Promise<void> {
    const mems = Array.isArray(frame.mems) ? frame.mems : []
    if (mems.length === 0) return
    const ordered = [...mems].sort((a, b) => Number(a.memSeq ?? 0) - Number(b.memSeq ?? 0))
    let maxSeq = this.peerNode ? getMemCursor(this.peerNode) : 0
    for (const m of ordered) {
      try {
        await ingestMeshMemory(m, this.peerNode || undefined)
      } catch {
        // Durability gate: stop advancing the cursor at the last applied seq. The
        // unapplied tail (this seq and beyond) replays on the next hello/reconnect.
        break
      }
      const seq = Number(m.memSeq ?? 0)
      if (seq > maxSeq) maxSeq = seq
    }
    if (this.peerNode && maxSeq > 0) setMemCursor(this.peerNode, maxSeq)
  }

  private onGossip(frame: GossipFrame): void {
    if (frame.node) this.learnPeer(frame.node)
    const sessions = Array.isArray(frame.sessions) ? frame.sessions : []
    const mesh = getMeshState()
    if (frame.node && frame.self) mesh.recordNodeUrl(frame.node, frame.self)
    mesh.mergeGossip(frame.node, sessions, Date.now())
    if (Array.isArray(frame.nodes)) {
      mesh.mergeNodes(frame.nodes, Date.now())
      // G3: a roster-learned node's advertised url is a real dial candidate, not a
      // display-only row. Feed each through the SAME probe-gated path as addresses[]
      // (self-exclude + dedup + probe-before-dial) so a node learned purely via the
      // relayed roster becomes dialable AND re-propagates via our knownAddresses().
      this.learnAddresses(frame.nodes.map((n) => n.url).filter((u): u is string => !!u))
    }
    if (frame.node) mesh.recordActivity(this.key, Date.now())
    this.learnAddresses(frame.addresses)
  }

  /**
   * Address-list gossip ingest (L2): for each gossiped address we DON'T already
   * know, register it `unknown` and schedule a probe (classifyAndMaybeDial). NEVER
   * `connectPeer` directly here — a gossiped address may be unreachable FROM HERE
   * (the per-edge asymmetry); only the probe path may decide to dial. Fire-and-forget.
   */
  private learnAddresses(addresses: string[] | undefined): void {
    if (!Array.isArray(addresses) || addresses.length === 0) return
    const mesh = getMeshState()
    const known = new Set(mesh.knownAddresses())
    const self = selfUrl()
    let learned = false
    for (const url of addresses) {
      // Self-exclude: never learn/probe/dial our OWN address (would self-loop).
      if (!url || url === self || known.has(url)) continue
      mesh.learnAddress(url)
      learned = true
      // Fire-and-forget probe/dial. classifyAndMaybeDial is non-throwing, but keep an
      // explicit .catch so a future regression here can never become an
      // unhandledRejection that crashes the shared server (belt-and-suspenders to the
      // global guard in server/index.ts).
      classifyAndMaybeDial(url).catch((e) =>
        console.warn(`[ckn] learnAddresses dial(${url}) error:`, e instanceof Error ? e.message : e),
      )
    }
    // A newly-learned address changed the registry — persist it (debounced) so the
    // peer set survives a restart even before its probe verdict lands.
    if (learned) schedulePersist()
  }

  /** Record the peer's node id (idempotent) + mark this link's peer reachable. */
  private learnPeer(node: string): void {
    if (this.peerNode === node) return
    this.peerNode = node
    const mesh = getMeshState()
    mesh.markReachable(this.key, node, 0, Date.now())
    // An ACCEPTED (inbound) link means this peer dialed US — record it so a probe
    // that fails FROM HERE classifies the edge `reception-only` (send over the link
    // they opened) rather than `unreachable`. Dialed links never set this.
    if (!this.dialed) mesh.markInboundNode(node)
    // peerNode is now known → resolve any duplicate-link race (L2-T4 failover).
    dedupeLinks(this)
  }

  private teardown(): void {
    if (this.closed) return
    this.closed = true
    this.unsubMsg?.()
    this.unsubMem?.()
    this.unsubState?.()
    if (this.gossipTimer) {
      clearInterval(this.gossipTimer)
      this.gossipTimer = null
    }
    if (this.hsTimer) {
      clearTimeout(this.hsTimer)
      this.hsTimer = null
    }
    const mesh = getMeshState()
    if (this.dialed) mesh.markUnreachable(this.key, Date.now())
    else mesh.removePeer(this.key) // ephemeral-keyed accept link — prune, don't accumulate
    onLinkClosed(this)
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
    this.teardown()
  }
}

// ── link registry ────────────────────────────────────────────────────────────

const links = new Set<Link>()

function onLinkClosed(link: Link): void {
  links.delete(link)
}

/**
 * Decide whether a link to `peerNode` should be KEPT, given who dialed it
 * (`dialed`) and our own `selfNode`. The canonical dialer is the lower nodeId:
 *   - selfNode < peerNode  → WE dial; keep our DIALED link (`dialed === true`).
 *   - selfNode > peerNode  → THEY dial; keep the link THEY opened to us, i.e. our
 *                            ACCEPTED/inbound link (`dialed === false`).
 * Pure + deterministic (no `Date.now()`, no I/O) so the tiebreak is unit-testable.
 * `selfNode === peerNode` can't happen (self-exclude), but treat it as "keep" to
 * avoid ever closing the last link on a degenerate id collision.
 */
export function shouldKeepLink(selfNode: string, peerNode: string, dialed: boolean): boolean {
  if (selfNode === peerNode) return true
  const weAreCanonicalDialer = selfNode < peerNode
  return dialed === weAreCanonicalDialer
}

/**
 * Symmetric-failover dedupe (L2-T4): two mutually-reachable nodes may BOTH dial,
 * leaving us with two live links to the same peerNode (our dialed one + the inbound
 * one they opened). Keep exactly ONE — the link dialed by the lower nodeId
 * (`shouldKeepLink`); close the rest. Called from `learnPeer`, once `peerNode` is
 * known. Either side may re-dial on a drop (no master/slave): the loser's close is
 * a benign teardown, and the canonical dialer's reconnector re-establishes the
 * single link if it later drops.
 *
 * Safety: if the link we're CURRENTLY processing a frame on (`current`) loses the
 * tiebreak, we DEFER its close to the next tick (`setImmediate`) so the in-flight
 * frame handler returns cleanly before the socket tears down. Other losers close
 * immediately (no active frame on them).
 */
function dedupeLinks(current: Link): void {
  const peerNode = current.peerNode
  if (!peerNode) return
  const self = nodeId()
  const dupes = Array.from(links).filter((l) => l.peerNode === peerNode)
  if (dupes.length < 2) return

  // Survivors = links on the canonical side of the tiebreak. Normally exactly one
  // (our dialed XOR our accepted). Guard the degenerate case where both dupes carry
  // the SAME dialed flag (e.g. a stale inbound socket lingering beside a fresh one):
  // there'd be 0 or 2 "survivors", so fall back to keeping a single deterministic
  // one (prefer `current`, else the first) so we never close the LAST link.
  let survivors = dupes.filter((l) => shouldKeepLink(self, peerNode, l.dialed))
  if (survivors.length !== 1) {
    const keep = survivors.includes(current) ? current : (survivors[0] ?? current)
    survivors = [keep]
  }
  const keep = survivors[0]

  for (const link of dupes) {
    if (link === keep) continue
    // A DIALED loser means the PEER is the canonical dialer (lower nodeId) and owns
    // the connection — stop OUR reconnector for it so we don't re-dial straight into
    // another dedupe (churn loop). The peer re-dials on a drop; we hold their inbound.
    if (link.dialed) stopReconnector(link.key)
    if (link === current) setImmediate(() => link.close())
    else link.close()
  }
}

// ── client side: connectPeer with capped backoff ───────────────────────────────

/** Active reconnect controllers, keyed by dial url, so stopWsMesh can halt them. */
interface Reconnector {
  url: string
  stopped: boolean
  attempt: number
  timer: ReturnType<typeof setTimeout> | null
}
const reconnectors = new Map<string, Reconnector>()

function wsEndpoint(url: string): string {
  // url is `http://host:port`; the WS endpoint is `ws://host:port/api/mesh/ws`.
  const ws = url.replace(/^http/i, 'ws').replace(/\/+$/, '')
  return `${ws}/api/mesh/ws`
}

/**
 * Open + maintain a client link to `url` (a peer's `http://host:port` base).
 * Reconnects with capped exponential backoff on close/error. A successful open
 * resets the backoff. Idempotent per url.
 */
export function connectPeer(url: string): void {
  if (reconnectors.has(url)) return
  const rc: Reconnector = { url, stopped: false, attempt: 0, timer: null }
  reconnectors.set(url, rc)
  dial(rc)
}

function dial(rc: Reconnector): void {
  if (rc.stopped) return
  let ws: WebSocket
  try {
    // Open UNPRIVILEGED — no Authorization header. The fleet token is NEVER sent;
    // the in-band MeshHandshake authenticates post-open (slice #4C).
    ws = new WebSocket(wsEndpoint(rc.url))
  } catch {
    scheduleReconnect(rc)
    return
  }
  const link = new Link(ws, rc.url, true)
  links.add(link)
  ws.on('open', () => {
    rc.attempt = 0 // healthy connection resets the backoff
  })
  const onDown = () => scheduleReconnect(rc)
  ws.on('close', onDown)
  ws.on('error', onDown)
}

/**
 * Halt + drop the reconnector for a dial url (no further re-dials). Used by the
 * failover dedupe: when our dialed link loses the lower-nodeId tiebreak, the peer
 * owns the connection, so we stop dialing it. Idempotent (no-op if absent).
 */
function stopReconnector(url: string): void {
  const rc = reconnectors.get(url)
  if (!rc) return
  rc.stopped = true
  if (rc.timer) {
    clearTimeout(rc.timer)
    rc.timer = null
  }
  reconnectors.delete(url)
}

function scheduleReconnect(rc: Reconnector): void {
  if (rc.stopped || rc.timer) return
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** rc.attempt, BACKOFF_CAP_MS)
  rc.attempt += 1
  rc.timer = setTimeout(() => {
    rc.timer = null
    dial(rc)
  }, delay)
  rc.timer.unref()
}

// ── server side: accept an inbound peer socket ─────────────────────────────────

/** Wrap an accepted server socket in a link (passive — never dials back). */
export function acceptPeer(ws: WebSocket): void {
  const remote =
    // @ts-expect-error _socket is the underlying net.Socket on a ws server socket
    `ws:${ws._socket?.remoteAddress ?? 'peer'}:${ws._socket?.remotePort ?? ''}`
  const link = new Link(ws, remote, false)
  links.add(link)
}

// ── lifecycle ──────────────────────────────────────────────────────────────────

/** Dial the static config peers AND any extra candidates (initiator role). `extra` =
 *  learned peers seeded from mesh-peers.json on a token-only node, so it re-dials them
 *  on restart instead of booting accept-only (#93). Deduped; connectPeer is idempotent
 *  per url, so an overlap between the static and seeded sets is harmless. */
export function startWsInitiator(extra: string[] = []): void {
  const targets = new Set<string>(peerUrls())
  for (const url of extra) targets.add(url)
  for (const url of targets) connectPeer(url)
}

/** Stop all reconnect loops and close every open link. */
export function stopWsMesh(): void {
  for (const rc of reconnectors.values()) {
    rc.stopped = true
    if (rc.timer) {
      clearTimeout(rc.timer)
      rc.timer = null
    }
  }
  reconnectors.clear()
  for (const link of Array.from(links)) link.close()
  links.clear()
}

/** Number of live links (diagnostics + mesh-status). */
export function wsPeerCount(): number {
  return links.size
}

/** Per-link diagnostic view: peer node id + connected + who dialed it. */
export function wsLinks(): Array<{ peerNode: string; connected: boolean; dialed: boolean }> {
  return Array.from(links).map((l) => ({
    peerNode: l.peerNode,
    connected: l.ws.readyState === WebSocket.OPEN,
    dialed: l.dialed,
  }))
}
