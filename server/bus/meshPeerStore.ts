/**
 * Persistence for the mesh's LEARNED peer set (FR-7 G1 / decision D4). The live
 * registry (meshState) is seeded at boot from the STATIC config (mesh.json/env);
 * this layer adds the peers a node learned via gossip at its LAST connection, so
 * the mesh re-forms across a restart WITHOUT having to re-contact a static seed
 * first (the flat-hive "self-form without a hand-pinned peer" goal).
 *
 * Stored at ~/.config/ckn/mesh-peers.json as {url, capability, lastGoodAt}[].
 * `lastGoodAt` = the last time the peer was actually GOOD (gossiped / active),
 * NOT merely probed — so an unreachable peer's clock freezes and it ages out of
 * the seed after TTL instead of being re-seeded forever. Read is fail-soft
 * (missing/corrupt → []); write is best-effort, atomic (tmp+rename), debounced.
 *
 * One-way dependency: this imports meshState; meshState NEVER imports this (it
 * stays pure + deterministic for tests). Boot wiring + the mutate sites call in.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { getMeshState, type PersistedPeer } from './meshState.js'

const DEFAULT_PEERS_PATH = path.join(os.homedir(), '.config', 'ckn', 'mesh-peers.json')
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7d — a peer not seen-good within this ages out

export function peersPath(): string {
  return process.env.CKN_MESH_PEERS_FILE || DEFAULT_PEERS_PATH
}
export function peerTtlMs(): number {
  const raw = Number(process.env.CKN_MESH_PEER_TTL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS
}

/** Load persisted peers, dropping any whose lastGoodAt is older than ttl. Fail-soft:
 *  a missing, unreadable, non-JSON, or non-array file yields [] (never throws). */
export function loadPersistedPeers(file: string, now: number, ttlMs: number): PersistedPeer[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: PersistedPeer[] = []
  for (const e of parsed as any[]) {
    if (!e || typeof e.url !== 'string' || !e.url) continue
    const lastGoodAt = Number(e.lastGoodAt) || 0
    if (lastGoodAt > 0 && now - lastGoodAt > ttlMs) continue // aged out
    out.push({ url: e.url, capability: e.capability ?? 'unknown', lastGoodAt })
  }
  return out
}

/** Write the peer set atomically (tmp+rename, per-pid tmp). Best-effort; never throws. */
export function savePersistedPeers(file: string, rows: PersistedPeer[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2))
    fs.renameSync(tmp, file)
  } catch {
    /* best-effort — a persistence failure must never break the mesh */
  }
}

/** Seed the live registry with persisted peers (as discovery candidates) at boot.
 *  They enter as `unknown` (learnAddress) so the discovery sweep re-probes + dials
 *  the still-reachable ones — topology may have changed since last connection.
 *  Static-config peers are already seeded separately. Returns the seeded urls so the
 *  caller can ARM the dialer for a token-only node (no static peers) — otherwise it
 *  would seed the registry but boot accept-only and never re-dial them (#93). */
export function initMeshPeers(file = peersPath(), now = Date.now(), ttlMs = peerTtlMs()): string[] {
  const mesh = getMeshState()
  const persisted = loadPersistedPeers(file, now, ttlMs)
  for (const p of persisted) mesh.learnAddress(p.url)
  return persisted.map((p) => p.url)
}

let timer: ReturnType<typeof setTimeout> | null = null
/** Debounced persist of the registry's worth-keeping peers. Called from the mutate
 *  sites (learnAddresses, probe-verdict). Coalesces a burst into one write. */
export function schedulePersist(delayMs = 2_000): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    savePersistedPeers(peersPath(), getMeshState().exportPersistable(Date.now(), peerTtlMs()))
  }, delayMs)
  timer.unref?.()
}
