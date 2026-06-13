/**
 * The mesh's live, in-process view: a reachable-peer registry (seeded from
 * `peerUrls()`) and the gossiped remote-presence map (per-source TTL'd).
 *
 * This is a process-singleton — the gossip loop (meshGossip.ts), the routes
 * (routes/mesh.ts), and the MeshBroker all mutate/read the SAME instance via
 * `getMeshState()`. Cursors live in the `mesh_cursors` table (server/graph/bus.ts),
 * NOT here; this holds only the volatile view.
 *
 * Wall-clock is injected (`now` params) so the logic is deterministic under test;
 * no helper reads `Date.now()` itself.
 */
import { peerUrls } from './meshIdentity.js'
import { presenceStatus } from './identity.js'
import type { SessionPresence } from '../graph/_rows.js'

/**
 * Per-edge dial capability (L2). Distinct from `reachable`, which is the *live*
 * link health; capability is the *probe verdict* deciding whether we ever dial:
 *   - `unknown`        — learned (e.g. via gossip) but not yet probed.
 *   - `reachable`      — a probe succeeded → eligible to (re)dial.
 *   - `reception-only` — probe failed BUT this peer dialed us (we hold an inbound
 *                        link) → send over that link, never dial; they own reconnect.
 *   - `unreachable`    — probe failed and no inbound link → record, don't dial, re-probe.
 */
export type PeerCapability = 'unknown' | 'reachable' | 'reception-only' | 'unreachable'

/** Per-peer reachability + accounting. `url` is the normalized base (no trailing /). */
export interface PeerState {
  url: string
  nodeId?: string
  reachable: boolean
  /** epoch ms of the last successful gossip; 0 = never. */
  lastGossipAt: number
  /** sessions this peer reported live in its most recent gossip. */
  sessionCount: number
  /** epoch ms of the last sign of life (gossip-with-sessions, ingest, state). */
  lastActivityAt: number
  /** reachable + idle long enough → excluded from the active fleet + broadcast. */
  zombie: boolean
  /** Per-edge dial verdict (L2). Default `unknown` until probed. */
  capability: PeerCapability
  /** epoch ms of the last probe that set `capability`; 0 = never probed. */
  lastProbeAt: number
  /** true once we accept an inbound link from this node (drives reception-only). */
  hasInbound: boolean
}

/** A gossiped remote presence, tagged with where it came from + when we saw it. */
export type GossipedPresence = SessionPresence & {
  sourceNode: string
  receivedAt: number
}

/** Default gossip interval (ms) — mirrors CKN_MESH_GOSSIP_MS default in the spec. */
const DEFAULT_GOSSIP_MS = 20_000

function gossipMs(): number {
  const raw = Number(process.env.CKN_MESH_GOSSIP_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GOSSIP_MS
}

export class MeshState {
  private readonly peers = new Map<string, PeerState>()
  /** keyed by sessionId — last-writer-wins across gossip rounds. */
  private readonly gossiped = new Map<string, GossipedPresence>()

  /** Seed the registry from `peerUrls()`. Idempotent; preserves existing state. */
  constructor(seed: string[] = peerUrls()) {
    for (const url of seed) this.ensurePeer(url)
  }

  /** Get-or-create a peer row in its initial (unreachable, never-gossiped) state. */
  private ensurePeer(url: string): PeerState {
    let p = this.peers.get(url)
    if (!p) {
      p = {
        url,
        reachable: false,
        lastGossipAt: 0,
        sessionCount: 0,
        lastActivityAt: 0,
        zombie: false,
        capability: 'unknown',
        lastProbeAt: 0,
        hasInbound: false,
      }
      this.peers.set(url, p)
    }
    return p
  }

  /** All known peer rows (registry order). For diagnostics + the gossip loop. */
  allPeers(): PeerState[] {
    return Array.from(this.peers.values())
  }

  /** Peer urls the gossip loop should probe — every seeded peer, reachable or not. */
  peerUrls(): string[] {
    return Array.from(this.peers.keys())
  }

  /**
   * Register an address we've heard about (e.g. via address-list gossip) so the
   * prober can classify it. New entries start `unknown`; idempotent — an existing
   * peer keeps its capability + accounting untouched.
   */
  learnAddress(url: string): void {
    this.ensurePeer(url)
  }

  /** Record a probe verdict for a peer, stamping when it was decided. */
  setCapability(key: string, cap: PeerCapability, now: number): void {
    const p = this.ensurePeer(key)
    p.capability = cap
    p.lastProbeAt = now
  }

  /** Every address we've seen (registry keys) — the set gossip advertises. */
  knownAddresses(): string[] {
    return Array.from(this.peers.keys())
  }

  /** Addresses a probe classified `reachable` — the effective WS dial-list. */
  dialTargets(): string[] {
    return Array.from(this.peers.values())
      .filter((p) => p.capability === 'reachable')
      .map((p) => p.url)
  }

  /** Note that this node dialed us (we hold an inbound link) — enables reception-only. */
  markInbound(key: string): void {
    const p = this.ensurePeer(key)
    p.hasInbound = true
  }

  // ── inbound tracking keyed by NODE id (not the ephemeral accept-socket key) ──
  // An accepted link is keyed by an ephemeral remote-port string, so its PeerState's
  // `hasInbound` can't be found by a base-url probe. Track inbound by the peer's stable
  // node id + the peer's advertised own url (`recordNodeUrl`), so a probe that fails
  // FROM HERE can ask "do I hold an inbound link from the peer at this url?" and
  // classify reception-only correctly.
  private readonly inboundNodes = new Set<string>()
  private readonly nodeSelfUrl = new Map<string, string>()

  /** An accepted (inbound) link learned its peer's node id. */
  markInboundNode(node: string): void {
    if (node) this.inboundNodes.add(node)
  }

  /** Record a node's advertised own base url (from its hello/gossip `self`). */
  recordNodeUrl(node: string, url: string): void {
    if (node && url) this.nodeSelfUrl.set(node, url)
  }

  /** Do we hold an inbound link from the peer whose advertised own url is `url`?
   * (A NAT'd pure-dialer advertises no url ⇒ false here — correct: we never learn its
   * url to classify it; we just send over the link it opened to us.) */
  hasInboundForUrl(url: string): boolean {
    for (const [node, u] of this.nodeSelfUrl) {
      if (u === url && this.inboundNodes.has(node)) return true
    }
    return false
  }

  /**
   * Mark a peer reachable after a successful gossip. Returns `true` iff this was
   * an unreachable→reachable TRANSITION (so the caller fires catch-up exactly
   * once per recovery, not on every steady-state tick).
   */
  markReachable(url: string, nodeId: string, sessionCount: number, now: number): boolean {
    const p = this.ensurePeer(url)
    const wasUnreachable = !p.reachable
    p.reachable = true
    p.nodeId = nodeId
    p.sessionCount = sessionCount
    p.lastGossipAt = now
    // Any reported session, or any gossip carrying activity, is a sign of life
    // that clears a zombie verdict and resets the silence clock. A reachable peer
    // with no sessions yet starts its silence clock at FIRST contact (not epoch),
    // so it only ages into a zombie after `zombieMs` of being-seen-but-empty.
    if (sessionCount > 0) {
      p.lastActivityAt = now
      p.zombie = false
    } else if (p.lastActivityAt === 0) {
      p.lastActivityAt = now
    }
    return wasUnreachable
  }

  /** Mark a peer unreachable (failed/timed-out gossip). Its sessions drop from the view. */
  markUnreachable(url: string, _now: number): void {
    const p = this.ensurePeer(url)
    p.reachable = false
  }

  /** Drop a peer entry entirely. Used for accept-side WS links keyed by an ephemeral
   * remote port: each reconnect mints a new key, so without pruning the map grows
   * unbounded with dead entries. (Dialed links keep a stable url key and just go
   * unreachable on drop, since they re-dial.) */
  removePeer(key: string): void {
    this.peers.delete(key)
  }

  /**
   * Bump the activity clock + clear any zombie verdict. Called on a gossip that
   * carried sessions, on ingest, and on state apply — anything that proves the
   * peer is doing real work, not just answering health probes.
   */
  recordActivity(url: string, now: number): void {
    const p = this.ensurePeer(url)
    p.lastActivityAt = now
    p.zombie = false
  }

  /**
   * Zombie rule (locked): a peer that is REACHABLE (gossip succeeds) yet reports
   * ZERO sessions and has been silent past `zombieMs` is a zombie → dropped from
   * the active fleet + broadcast targets, but kept in the registry + re-probed
   * (a fresh session/activity revives it via markReachable/recordActivity).
   */
  evaluateZombies(now: number, zombieMs: number): void {
    for (const p of this.peers.values()) {
      if (p.reachable && p.sessionCount === 0 && now - p.lastActivityAt > zombieMs) {
        p.zombie = true
      }
    }
  }

  /** Reachable, non-zombie peer urls — the set a broadcast actually fans out to. */
  broadcastTargets(): string[] {
    return Array.from(this.peers.values())
      .filter((p) => p.reachable && !p.zombie)
      .map((p) => p.url)
  }

  /** True iff `sourceNode` belongs to a peer currently marked a zombie. */
  private isZombieSource(sourceNode: string): boolean {
    for (const p of this.peers.values()) {
      if (p.nodeId === sourceNode && p.zombie) return true
    }
    return false
  }

  /**
   * Merge a gossip snapshot from `sourceNode` into the remote-presence view.
   * Each session is re-tagged with its source + `receivedAt = now` so the TTL
   * sweep can age out a whole node's presences when it goes dark.
   */
  mergeGossip(sourceNode: string, sessions: SessionPresence[], now: number): void {
    for (const s of sessions) {
      this.gossiped.set(s.sessionId, { ...s, sourceNode, receivedAt: now })
    }
  }

  /**
   * The current gossiped remote-presence view. Drops:
   *   - presences whose source hasn't refreshed within `2 × gossip interval`
   *     (TTL — a node gone dark stops showing ghost sessions), and
   *   - presences from a zombied source node.
   * Pure read; the actual eviction from the backing Map happens lazily on the
   * next mergeGossip overwrite, so this is the authoritative filter.
   */
  gossipedPeers(now: number): SessionPresence[] {
    const ttl = 2 * gossipMs()
    const out: SessionPresence[] = []
    for (const [id, g] of this.gossiped) {
      if (now - g.receivedAt > ttl) {
        this.gossiped.delete(id)
        continue
      }
      if (this.isZombieSource(g.sourceNode)) continue
      const { sourceNode: _s, receivedAt: _r, ...presence } = g
      out.push(presence)
    }
    return out
  }

  /**
   * The presence set to gossip onward: our OWN local sessions (`local`, passed in
   * already live/idle) PLUS every live/idle REMOTE session we currently know,
   * deduped by sessionId with local winning. Re-advertising learned remote
   * sessions is what turns 1-hop presence into router/DNS-style propagation — a
   * spoke learns other spokes' sessions through the hub's relay, exactly as
   * `rosterForGossip` does for the node roster.
   *
   * Liveness is judged by each session's OWN `lastSeen` (carried verbatim through
   * every hop), NOT by per-hop receipt time: a dead origin's `lastSeen` freezes,
   * so it ages past idle and every relayer stops re-advertising it. That is what
   * stops two directly-linked nodes from refreshing a dead session to each other
   * forever (an immortal ghost) — relay can never outlive the origin's lastSeen.
   */
  presencesForGossip(local: SessionPresence[], now: number): SessionPresence[] {
    const byId = new Map<string, SessionPresence>()
    for (const p of this.gossipedPeers(now)) {
      const s = presenceStatus({ lastSeen: p.lastSeen, rawStatus: p.rawStatus }, now)
      if (s === 'live' || s === 'idle') byId.set(p.sessionId, p)
    }
    // Local wins: our own row is the freshest + authoritative for a session that
    // lives here, and dedups any copy of it that relayed back to us.
    for (const p of local) byId.set(p.sessionId, p)
    return Array.from(byId.values())
  }

  // ── node roster (full-fleet discovery + dedup) ──────────────────────────────
  // A gossiped, RELAYED set of every node the fleet knows about, keyed by the
  // CANONICAL machineId. Separate from session presence (above) so message
  // delivery is untouched. Two properties it gives the Machines page:
  //   - dedup: the canonical key folds a custom mesh nodeId to the computer, so
  //     one physical machine is one row no matter what nodeId it advertises.
  //   - full-fleet: each node re-advertises everything it has learned (relay),
  //     so the roster propagates multi-hop — add one node and it reaches all.
  private readonly knownNodes = new Map<string, KnownNode>() // keyed by machineId

  /** TTL for a learned node — a machine not re-heard within this window ages out
   *  of every node's roster (mirrors the roster's dormant→retire ceiling). */
  private static readonly NODE_TTL_MS = 24 * 60 * 60 * 1000

  /** Merge a gossiped node roster (self + relayed peers) by canonical machineId,
   *  keeping the freshest activity. Empty machineIds are ignored. */
  mergeNodes(nodes: KnownNode[], _now: number): void {
    for (const n of nodes) {
      const mid = (n.machineId || '').trim()
      if (!mid) continue
      const prev = this.knownNodes.get(mid)
      this.knownNodes.set(mid, {
        nodeId: n.nodeId || prev?.nodeId || mid,
        machineId: mid,
        hostname: n.hostname || prev?.hostname || '',
        // Prefer a non-empty advertised dial url (G3): a relay hop that dropped the
        // url must never erase a url we already learned — a NAT'd node advertises ''.
        url: n.url || prev?.url || '',
        lastActivityAt: Math.max(prev?.lastActivityAt ?? 0, n.lastActivityAt || 0),
      })
    }
  }

  /** The known fleet (TTL-pruned), one entry per canonical machine. */
  nodesForRoster(now: number): KnownNode[] {
    const out: KnownNode[] = []
    for (const [mid, n] of this.knownNodes) {
      if (now - n.lastActivityAt > MeshState.NODE_TTL_MS) {
        this.knownNodes.delete(mid)
        continue
      }
      out.push(n)
    }
    return out
  }

  /** Self + the known fleet, for gossiping onward. Re-advertising everything we
   *  have learned (not just self) is what makes the roster propagate multi-hop —
   *  a spoke learns other spokes through the hub's relay. Self is upserted with
   *  `now` so it always reads live. */
  rosterForGossip(self: KnownNode, now: number): KnownNode[] {
    this.mergeNodes([{ ...self, lastActivityAt: now }], now)
    return this.nodesForRoster(now)
  }

  /**
   * The peers worth persisting across a restart (FR-7 G1 / D4). A peer is kept iff
   * it has had a GOOD contact (`lastGoodAt = max(lastGossipAt, lastActivityAt) > 0`)
   * within `ttlMs`. Probe time is deliberately NOT part of `lastGoodAt`: a peer we
   * keep failing to reach must age out, not be re-seeded forever by its own probes.
   * Pure (reads the registry only); meshPeerStore does the actual file I/O.
   */
  exportPersistable(now: number, ttlMs: number): PersistedPeer[] {
    const out: PersistedPeer[] = []
    for (const p of this.peers.values()) {
      const lastGoodAt = Math.max(p.lastGossipAt, p.lastActivityAt)
      if (lastGoodAt <= 0) continue // never had a good contact — nothing to persist
      if (now - lastGoodAt > ttlMs) continue // aged out
      out.push({ url: p.url, capability: p.capability, lastGoodAt })
    }
    return out
  }
}

/** One node in the gossiped fleet roster. `machineId` (canonical) is the dedup
 *  key — the computer; `nodeId` is its mesh id (may be a custom override). */
export interface KnownNode {
  nodeId: string
  machineId: string
  hostname: string
  /** The node's advertised own base url (CKN_MESH_SELF), relayed so a node learned
   *  purely via the roster is a real DIAL candidate, not display-only (G3). '' for a
   *  NAT'd pure-dialer that advertises no url (reachable only over the link it dials). */
  url?: string
  lastActivityAt: number
}

/** A peer persisted across restarts (FR-7 G1 / D4). `lastGoodAt` = last time the
 *  peer was actually GOOD (gossiped/active), the TTL basis — see meshPeerStore. */
export interface PersistedPeer {
  url: string
  capability: PeerCapability
  lastGoodAt: number
}

let singleton: MeshState | null = null

/** The process-wide mesh state. Lazily seeded from `peerUrls()` on first use. */
export function getMeshState(): MeshState {
  if (!singleton) singleton = new MeshState()
  return singleton
}

/** Test seam: reset the singleton so a test starts from a known registry. */
export function _resetMeshState(seed?: string[]): MeshState {
  singleton = new MeshState(seed)
  return singleton
}
