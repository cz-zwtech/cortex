/**
 * Persisted NON-SECRET mesh config (~/.config/ckn/mesh.json). Lets WSL's :3001 come up mesh-on
 * across restarts without re-passing CKN_MESH_* env each time. The fleet TOKEN is never stored here —
 * it stays env-only (bao-run); meshAuth reads it separately. Env always wins over the file.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface MeshConfigFile { peers?: string[]; nodeId?: string; self?: string }

const configDir = (): string =>
  process.env.CKN_CONFIG_DIR || path.join(os.homedir(), '.config', 'ckn')
export const meshConfigPath = (): string => path.join(configDir(), 'mesh.json')

/**
 * In-memory cache of the parsed file, keyed by the resolved path. The file is
 * operator-edited at rest (ckn-mesh CLI / hand edit), not hot-mutated, so a
 * cached read is safe — and nodeId()/peerUrls()/selfUrl() sit on the per-message
 * mesh hot path (server/graph/bus.ts, server/bus/meshWs.ts), so we must not hit
 * disk on every bus frame. Mirrors the _state caching in server/usageScores.ts
 * and server/importedVaults.ts. writeMeshConfig() invalidates it so an in-process
 * write is reflected by the next read.
 */
let _cache: { path: string; value: MeshConfigFile } | null = null

/** Read + validate the file; returns {} when absent or malformed (never throws). Cached. */
export function readMeshConfig(): MeshConfigFile {
  const p = meshConfigPath()
  if (_cache && _cache.path === p) return _cache.value
  let out: MeshConfigFile = {}
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (Array.isArray(j?.peers)) out.peers = j.peers.filter((x: unknown) => typeof x === 'string')
    if (typeof j?.nodeId === 'string') out.nodeId = j.nodeId
    if (typeof j?.self === 'string') out.self = j.self
  } catch { out = {} }
  _cache = { path: p, value: out }
  return out
}

/** Drop the cached file so the next readMeshConfig() re-reads from disk. */
export function invalidateMeshConfig(): void {
  _cache = null
}

/** Merge a partial update into the file (used by the ckn-mesh CLI). */
export function writeMeshConfig(patch: MeshConfigFile): void {
  const cur = readMeshConfig()
  const next = { ...cur, ...patch }
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(meshConfigPath(), JSON.stringify(next, null, 2))
  invalidateMeshConfig()
}
