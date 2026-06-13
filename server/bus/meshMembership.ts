/**
 * FR-7 D1 — membership controller. Mesh membership is a CONTINUOUS reachability
 * logic test, never a boot-once env flip. On a timer (+ an immediate first tick):
 *
 *   - not CONFIGURED for mesh (no peers AND no token source) → ensure the tier is
 *     DOWN (pure local) and stop. A standalone node never runs the mesh tier.
 *   - configured → acquire the token (env, or a runtime fetch via bao-run — D2). No
 *     token yet (e.g. OpenBao unreachable off-VPN) → ensure DOWN (local-only) and
 *     retry next tick. Token available → ensure the tier is UP.
 *
 * Tier UP (idempotent): seed persisted peers, dial configured peers, run discovery,
 * and swap the broker to federated (presence merge + federated reads). Inbound
 * accept is always mounted and authorizes the moment a token exists. So a node that
 * boots off-VPN comes up local-only and JOINS automatically within one tick of
 * OpenBao + peers becoming reachable — no restart, no env change.
 */
import { peerUrls } from './meshIdentity.js'
import { acquireMeshToken, tokenCmd } from './meshTokenSource.js'
import { startWsInitiator, stopWsMesh } from './meshWs.js'
import { startDiscovery, stopDiscovery } from './meshDiscovery.js'
import { initMeshPeers } from './meshPeerStore.js'
import { resolveBroker } from './broker.js'

const DEFAULT_MEMBERSHIP_MS = 30_000
function membershipMs(): number {
  const raw = Number(process.env.CKN_MESH_MEMBERSHIP_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MEMBERSHIP_MS
}

/**
 * Configured for mesh = a dial-list OR a token source (env token / token cmd). A
 * node with none of these is standalone — the mesh tier never runs (pure local).
 */
export function meshConfigured(): boolean {
  return peerUrls().length > 0 || !!process.env.CKN_MESH_TOKEN || !!tokenCmd()
}

let tierUp = false

/** Bring the WS mesh tier up (idempotent): seed persisted peers, dial, discover,
 *  and swap the broker to federated so remote presence + reads merge. */
async function realTierUp(): Promise<void> {
  if (tierUp) return
  tierUp = true
  const seeded = initMeshPeers()
  if (seeded.length > 0) console.log(`[ckn] mesh: seeded ${seeded.length} persisted peer(s) from last connection`)
  // Arm the dialer when there are STATIC peers OR seeded learned peers — else a
  // token-only node (no static config) that learned a peer last connection would
  // seed it but boot accept-only and never re-dial it (#93). startWsInitiator dials
  // both sets, deduped.
  if (peerUrls().length > 0 || seeded.length > 0) {
    startWsInitiator(seeded)
    console.log(
      `[ckn] mesh: tier UP — dialing ${peerUrls().length} static + ${seeded.length} learned peer(s) + accepting inbound`,
    )
  } else {
    console.log('[ckn] mesh: tier UP — accept-only (no dial-list)')
  }
  startDiscovery()
  await resolveBroker() // local-only → FederatedBroker
}

/** Tear the WS mesh tier down to local-only (idempotent). */
async function realTierDown(): Promise<void> {
  if (!tierUp) return
  tierUp = false
  stopDiscovery()
  stopWsMesh()
  await resolveBroker() // FederatedBroker → local-only
  console.log('[ckn] mesh: tier DOWN — local-only')
}

// Injection seam: tests replace the tier actions to assert the control logic
// without real dialing / broker swaps.
let upImpl: () => void | Promise<void> = realTierUp
let downImpl: () => void | Promise<void> = realTierDown
export function _setTierActions(
  up: (() => void | Promise<void>) | null,
  down: (() => void | Promise<void>) | null,
): void {
  upImpl = up ?? realTierUp
  downImpl = down ?? realTierDown
}
export function _membershipState(): { tierUp: boolean } {
  return { tierUp }
}

let ticking = false
/**
 * One membership evaluation. Guarded against overlap (a slow token fetch must not
 * let the interval stack ticks). Never throws.
 */
export async function membershipTick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    if (!meshConfigured()) {
      await downImpl()
      return
    }
    const haveToken = await acquireMeshToken()
    if (haveToken) await upImpl()
    else await downImpl() // configured but token unreachable → local-only; retry next tick
  } catch (e: any) {
    console.warn('[ckn] mesh: membership tick failed (local-only):', e?.message ?? e)
  } finally {
    ticking = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null
/** Start the membership controller: an immediate tick + periodic re-evaluation
 *  (CKN_MESH_MEMBERSHIP_MS, default 30s). Idempotent; the timer is `.unref()`'d. */
export function startMembership(): void {
  if (timer) return
  void membershipTick()
  timer = setInterval(() => void membershipTick(), membershipMs())
  timer.unref()
}

/** Stop the controller + tear the tier down. Used by graceful shutdown so a tick
 *  can't re-start the tier mid-close. */
export function stopMembership(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  void realTierDown()
}
