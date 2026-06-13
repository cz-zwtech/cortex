/**
 * Transport seam. The local tier is the GraphBroker (SQLite, this machine) and
 * is always present. When the mesh tier is enabled (`CKN_MESH_PEERS` set AND
 * `CKN_MESH_TOKEN` present — see `meshEnabled()`), a decentralized cross-machine
 * tier (MeshBroker) is composed in via a FederatedBroker; otherwise the bus is
 * pure-local. Callers (routes/CLI/hooks) call `getBroker()` and never change.
 *
 * Because routes call `getBroker()` once at module load, it returns a stable
 * PROXY that always delegates to the currently-resolved broker. Mesh activation
 * is a one-shot decision at boot (fail-closed on a missing token) — peers come
 * and go via the gossip loop, not a broker swap — so resolution runs once.
 * Remote/connection errors never throw to callers; the FederatedBroker degrades
 * to local-only behind the scenes.
 */
import {
  registerSession,
  heartbeat,
  touchSession,
  signoff,
  sendMessage,
  inbox,
  markDelivered,
  ackMessage,
  listPeers,
  type RegisterInput,
  type SendInput,
  type SessionPresence,
  type BusMessageRow,
} from '../graph/bus.js'
import { meshEnabled } from './meshAuth.js'
import { peerUrls } from './meshIdentity.js'

export interface MessageBroker {
  register(input: RegisterInput): Promise<SessionPresence>
  heartbeat(sessionId: string): Promise<void>
  touch(sessionId: string, cwd?: string, machine?: string, cadenceS?: number): Promise<void>
  signoff(sessionId: string): Promise<void>
  send(input: SendInput): Promise<{ id: string }>
  inbox(sessionId: string, opts?: { undeliveredOnly?: boolean }): Promise<BusMessageRow[]>
  markDelivered(sessionId: string, ids: string[]): Promise<void>
  ack(sessionId: string, id: string, kind: 'ack' | 'done'): Promise<void>
  peers(): Promise<SessionPresence[]>
}

/** Local tier — always available, the substrate for this machine's sessions. */
export const graphBroker: MessageBroker = {
  register: registerSession,
  heartbeat,
  touch: touchSession,
  signoff,
  send: sendMessage,
  inbox,
  markDelivered,
  ack: ackMessage,
  peers: listPeers,
}

/** Currently-resolved broker the proxy delegates to. Starts local-only. */
let resolved: MessageBroker = graphBroker
let resolving: Promise<void> | undefined
let lastTier: 'up' | 'off' | '' = ''

/**
 * Resolve the active broker from the mesh-tier gate. When enabled, compose the
 * MeshBroker remote tier into a FederatedBroker (local-authoritative +
 * remote-best-effort); otherwise stay local-only. Never throws — any failure
 * falls back to graphBroker. RE-RUNNABLE: the membership controller (FR-7 D1)
 * calls this on a tier transition so a node that fetches its token at runtime
 * upgrades local-only → federated (and back) WITHOUT a restart. Logs only on a
 * real transition.
 */
export async function resolveBroker(): Promise<void> {
  try {
    if (meshEnabled()) {
      const { MeshBroker } = await import('./meshBroker.js')
      const { FederatedBroker } = await import('./federatedBroker.js')
      resolved = new FederatedBroker(graphBroker, new MeshBroker())
      if (lastTier !== 'up') {
        lastTier = 'up'
        console.log(`[ckn] bus: mesh tier UP — ${peerUrls().length} peer(s)`)
      }
    } else {
      resolved = graphBroker
      if (lastTier !== 'off') {
        lastTier = 'off'
        console.log('[ckn] bus: mesh tier off — local-only (no cross-machine federation)')
      }
    }
  } catch (e: any) {
    console.warn('[ckn] bus: mesh tier unavailable, using local-only:', e?.message ?? e)
    resolved = graphBroker
  }
}

/** Stable proxy — every property access delegates to the live `resolved`. */
const proxyBroker: MessageBroker = {
  register: (input) => resolved.register(input),
  heartbeat: (sessionId) => resolved.heartbeat(sessionId),
  touch: (sessionId, cwd, machine, cadenceS) => resolved.touch(sessionId, cwd, machine, cadenceS),
  signoff: (sessionId) => resolved.signoff(sessionId),
  send: (input) => resolved.send(input),
  inbox: (sessionId, opts) => resolved.inbox(sessionId, opts),
  markDelivered: (sessionId, ids) => resolved.markDelivered(sessionId, ids),
  ack: (sessionId, id, kind) => resolved.ack(sessionId, id, kind),
  peers: () => resolved.peers(),
}

let started = false

/**
 * Returns a stable broker handle. On first call it kicks off async resolution so
 * the mesh tier swaps in once (when enabled); the returned proxy reflects the
 * swap without the caller re-fetching. If the mesh tier is off the proxy simply
 * stays on graphBroker.
 */
export const getBroker = (): MessageBroker => {
  if (!started) {
    started = true
    resolving = resolveBroker()
  }
  return proxyBroker
}

/** Test/shutdown hook: await the in-flight resolution. */
export const _awaitResolution = async (): Promise<void> => {
  if (resolving) await resolving
}
