/**
 * Probe-tested discovery (L2). Gossip propagates peer ADDRESS lists (L2-T2), but a
 * gossiped address may be unreachable FROM HERE (the per-edge asymmetry that drove
 * the WS channel: LAN→dev-lab works, dev-lab→LAN does not). So we NEVER dial a
 * gossiped address on faith — we PROBE it first and classify the edge:
 *
 *   - reachable      — a lightweight throwaway WS connect succeeds → add to the
 *                      effective dial-list and `connectPeer` it.
 *   - reception-only — the probe fails BUT this peer has dialed us (we hold an
 *                      inbound link) → we send over that link, never dial; they own
 *                      reconnect.
 *   - unreachable    — the probe fails and we hold no inbound link → record it,
 *                      don't dial, and re-probe on the periodic sweep (topology can
 *                      change — a peer or a route may come up later).
 *
 * Capability state + accounting live on `meshState` (L2-T1); this module is the
 * prober + the periodic re-classify sweep that drives it.
 */
import * as os from 'node:os'
import { WebSocket as WsWebSocket } from 'ws'
import { getMeshState } from './meshState.js'
import { connectPeer as realConnectPeer } from './meshWs.js'
import { schedulePersist } from './meshPeerStore.js'

/** Probe connect timeout — short; an unreachable edge must classify fast, not stall. */
const DEFAULT_PROBE_TIMEOUT_MS = 2_000
/** Default re-probe sweep interval. Re-classifies unknown + unreachable peers. */
const DEFAULT_PROBE_MS = 60_000

function probeMs(): number {
  const raw = Number(process.env.CKN_MESH_PROBE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROBE_MS
}

/**
 * The WS endpoint for a peer base url: `http://host:port` → `ws://host:port/api/mesh/ws`
 * (mirrors meshWs.ts `wsEndpoint`, kept local so the prober doesn't depend on a
 * non-exported helper).
 */
function wsEndpoint(url: string): string {
  const ws = url.replace(/^http/i, 'ws').replace(/\/+$/, '')
  return `${ws}/api/mesh/ws`
}

// ── injection seams (tests stub the WS impl + connectPeer deterministically) ────

/** Minimal constructable WS shape the prober needs: open/error/close + close(). */
type WsCtor = new (
  url: string,
  opts?: { headers?: Record<string, string> },
) => {
  on(event: 'open' | 'error' | 'close', cb: (...args: any[]) => void): void
  close(): void
}

let WebSocketImpl: WsCtor = WsWebSocket as unknown as WsCtor
let connectPeerImpl: (url: string) => void = realConnectPeer

/** Test seam: inject a fake WebSocket constructor so probes resolve deterministically. */
export function _setWebSocketImpl(impl: WsCtor | null): void {
  WebSocketImpl = (impl ?? (WsWebSocket as unknown as WsCtor)) as WsCtor
}

/** Test seam: inject a connectPeer spy. */
export function _setConnectPeer(fn: ((url: string) => void) | null): void {
  connectPeerImpl = fn ?? realConnectPeer
}

// ── probe ──────────────────────────────────────────────────────────────────────

/**
 * Open a throwaway authed WS to `wsEndpoint(url)` with a ~2s timeout. Resolves
 * `true` on the first `open` (then closes the probe socket), `false` on
 * error/close-before-open/timeout. NEVER throws — a probe failure is a verdict,
 * not an error.
 */
export function probe(
  url: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let ws: InstanceType<WsCtor> | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (!ok && ws) {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }
      resolve(ok)
    }

    timer = setTimeout(() => finish(false), timeoutMs)
    if (typeof (timer as any).unref === 'function') (timer as any).unref()

    try {
      // Reachability probe only — open UNPRIVILEGED (no token on the wire). We close
      // on 'open'; the real link (with the in-band handshake) is opened by connectPeer.
      ws = new WebSocketImpl(wsEndpoint(url))
    } catch {
      finish(false)
      return
    }

    ws.on('open', () => {
      // Reachable. Close the throwaway probe socket; the real link (if any) is
      // opened by classifyAndMaybeDial via connectPeer.
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      finish(true)
    })
    ws.on('error', () => finish(false))
    ws.on('close', () => finish(false)) // close before open ⇒ failure
  })
}

// ── classify + maybe dial ────────────────────────────────────────────────────────

/** Do we hold an inbound link from the peer at this url? Resolved by the peer's NODE
 * id + its advertised own url (meshState.hasInboundForUrl) — NOT the ephemeral accept
 * key, which never equals the base url a probe is classifying. */
function hasInbound(url: string): boolean {
  return getMeshState().hasInboundForUrl(url)
}

/**
 * Probe `url` and record the verdict:
 *   - probe ok    ⇒ capability `reachable` + `connectPeer(url)` (open the real link).
 *   - probe fails ⇒ `reception-only` if we hold an inbound link from this peer,
 *                   else `unreachable`.
 * Never throws (probe never throws; capability write is a plain Map mutation).
 */
export async function classifyAndMaybeDial(url: string, now: number = Date.now()): Promise<void> {
  // GENUINELY non-throwing: this is called fire-and-forget (`void
  // classifyAndMaybeDial(url)` in meshWs.learnAddresses) for every gossiped peer url,
  // so a throw here becomes an unhandledRejection → process crash (Node 20 default).
  // probe() is already safe; connectPeerImpl + schedulePersist are the throw vectors
  // (a malformed/junk url in the WS ctor, a persist I/O error) — swallow them so one
  // bad peer can never take the server down.
  try {
    const mesh = getMeshState()
    const ok = await probe(url)
    if (ok) {
      mesh.setCapability(url, 'reachable', now)
      connectPeerImpl(url)
    } else {
      mesh.setCapability(url, hasInbound(url) ? 'reception-only' : 'unreachable', now)
    }
    // Persist the updated peer/capability set (debounced) so it survives a restart.
    schedulePersist()
  } catch (e) {
    console.warn(`[ckn] classifyAndMaybeDial(${url}) swallowed error:`, e instanceof Error ? e.message : e)
  }
}

// ── periodic re-classify sweep ────────────────────────────────────────────────────

let sweepTimer: ReturnType<typeof setInterval> | null = null

/** Peers worth (re-)probing: never-classified (`unknown`) or previously `unreachable`
 * (topology may have changed). `reachable`/`reception-only` are left alone — the WS
 * link layer owns their health. */
function reprobeTargets(): string[] {
  return getMeshState()
    .allPeers()
    .filter((p) => p.capability === 'unknown' || p.capability === 'unreachable')
    .map((p) => p.url)
}

/**
 * Re-probe every `unknown`/`unreachable` peer NOW, dialing the ones that probe
 * reachable. The interval sweep and the network-change watcher (D5) both call this,
 * so a peer/route that just came up is discovered immediately, not on the next tick.
 */
export function triggerSweep(): void {
  for (const url of reprobeTargets()) void classifyAndMaybeDial(url)
}

// ── network-change watcher (FR-7 D5): re-probe immediately when the host's address
// set changes (VPN up/down, wifi switch, WSL mirrored-net toggle) so rejoin is
// near-instant rather than waiting up to a full probe interval. ──────────────────

let netTimer: ReturnType<typeof setInterval> | null = null
let lastFingerprint = ''

const DEFAULT_NETWATCH_MS = 10_000
function netWatchMs(): number {
  const raw = Number(process.env.CKN_MESH_NETWATCH_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NETWATCH_MS
}

/**
 * A stable fingerprint of the host's NON-internal addresses. A change between polls
 * means reachability may have changed → re-probe. Pure (the interfaces map is
 * injectable) so the change-detection is unit-testable without real interfaces.
 */
export function networkFingerprint(
  ifs: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string {
  const addrs: string[] = []
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] ?? []) {
      if (a.internal) continue
      addrs.push(`${a.family}:${a.address}`)
    }
  }
  return addrs.sort().join(',')
}

function startNetWatch(): void {
  if (netTimer) return
  lastFingerprint = networkFingerprint()
  netTimer = setInterval(() => {
    const fp = networkFingerprint()
    if (fp !== lastFingerprint) {
      lastFingerprint = fp
      triggerSweep() // address set changed → re-probe NOW (don't wait for the sweep)
    }
  }, netWatchMs())
  netTimer.unref()
}

function stopNetWatch(): void {
  if (!netTimer) return
  clearInterval(netTimer)
  netTimer = null
}

/**
 * Start the periodic discovery sweep: every `CKN_MESH_PROBE_MS` (default 60s),
 * re-run `classifyAndMaybeDial` for every `unknown`/`unreachable` peer so a peer or
 * route that comes up later is discovered and dialed — plus a network-change watcher
 * (D5) that triggers the same sweep immediately on an address-set change. Both timers
 * are `.unref()`'d (never hold the process up); idempotent (a second call is a no-op).
 */
export function startDiscovery(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => triggerSweep(), probeMs())
  sweepTimer.unref()
  startNetWatch()
}

/** Stop the discovery sweep + the network-change watcher. Idempotent. */
export function stopDiscovery(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  stopNetWatch()
}
