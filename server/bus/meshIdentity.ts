/**
 * Mesh node identity + peer addressing. Precedence: env wins, then the persisted
 * ~/.config/ckn/mesh.json fills the gap (via readMeshConfig, which is cached), then
 * the host machine id (nodeId only). The fleet token is never read here — it stays
 * env-only (bao-run). Tests must set CKN_CONFIG_DIR to an empty temp dir to stay
 * hermetic against a real mesh.json (see test/bus/mesh-identity.test.ts).
 */
import { getMachineId } from '../privateMind.js'
import { readMeshConfig } from './meshConfig.js'

/** This node's federation id — host-stable `${hostname}-${sha256(machine-id)[:8]}`,
 * unless `CKN_NODE_ID` overrides it. The override is required to run MULTIPLE mesh
 * nodes on ONE host (the machine-id is host-stable, so they'd otherwise collapse to a
 * single identity — links dedupe, cursors/echo-guard/routing all collide), and lets an
 * operator pin an explicit, stable node id. */
export function nodeId(): string {
  return process.env.CKN_NODE_ID || readMeshConfig().nodeId || getMachineId()
}

/**
 * Parse `CKN_MESH_PEERS` (csv of `http://host:port` or bare `host:port`) into a
 * normalized peer list:
 *   - bare `host:port` → `http://host:port`
 *   - trailing `/` trimmed
 *   - blanks dropped, duplicates deduped (first-wins order)
 *   - self dropped when known via `CKN_MESH_SELF` (best-effort self-exclude;
 *     unknown self is harmless because ingest is idempotent, but prefer dropping)
 */
export function peerUrls(): string[] {
  const raw = process.env.CKN_MESH_PEERS ?? ''
  const list = raw.trim() ? raw.split(',') : (readMeshConfig().peers ?? [])
  const self = selfUrl()
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of list) {
    const url = normalize(part)
    if (!url) continue
    if (self && url === self) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/** This node's own advertisable base url (`CKN_MESH_SELF`), normalized, or '' when
 * unset (e.g. a NAT'd node with no reachable address). Advertised in hello/gossip so
 * peers can map this node id ↔ url — which drives the reception-only classification. */
export function selfUrl(): string {
  return normalize(process.env.CKN_MESH_SELF ?? readMeshConfig().self ?? '')
}

/** Trim whitespace, prepend `http://` to a bare authority, strip a trailing `/`. */
function normalize(value: string): string {
  let v = value.trim()
  if (!v) return ''
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`
  return v.replace(/\/+$/, '')
}
