/**
 * The offline lifetime (mesh design section 9 Q3): messages for a node
 * that has been unreachable for X days are cleared, its senders told, every
 * node notified, and nothing more is accepted for it until it is back.
 *
 * X is counted from the node's last route from here, never from a message's
 * age. It is one global default with a per-node override:
 *
 *   CKN_MESH_OFFLINE_DAYS=10                      the default
 *   <mesh dir>/offline.json {"default": 10, "nodes": {"node-b": 3}}   by alias or id
 */
import fs from 'node:fs'
import path from 'node:path'

export const OFFLINE_ADDRESS = 'mesh:offline'
const DAY_MS = 24 * 60 * 60_000

export type OfflinePolicy = { defaultMs: number; nodes: Record<string, number> }

export const readOfflinePolicy = (dir: string, env: NodeJS.ProcessEnv = process.env): OfflinePolicy => {
  let defaultMs = Number(env.CKN_MESH_OFFLINE_DAYS ?? 10) * DAY_MS
  const nodes: Record<string, number> = {}
  try {
    const f = JSON.parse(fs.readFileSync(path.join(dir, 'offline.json'), 'utf-8')) as { default?: number; nodes?: Record<string, number> }
    if (typeof f.default === 'number') defaultMs = f.default * DAY_MS
    for (const [k, v] of Object.entries(f.nodes ?? {})) if (typeof v === 'number') nodes[k] = v * DAY_MS
  } catch {
    /* no file: the default */
  }
  return { defaultMs, nodes }
}

export const limitFor = (p: OfflinePolicy, node: string, alias?: string): number =>
  p.nodes[node] ?? (alias ? p.nodes[alias] : undefined) ?? p.defaultMs

/** Offline past its limit: unreachable now, and for longer than X since it last was. */
export const isExpired = (lastReachable: number, firstSeen: number, limitMs: number, reachableNow: boolean, now: number): boolean =>
  !reachableNow && now - (lastReachable || firstSeen) > limitMs

/** What a node floods when another passes its limit, and clears when it is back. */
export type OfflineNotice = { node: string; since: number | null }
