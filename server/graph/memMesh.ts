/**
 * M4 live memory propagation — replication over the WS mesh. Memories live as .md + `entries`;
 * this module adds a thin `mem_log` (bookkeeping + snapshot), a `mem` frame that mirrors the bus
 * `msg` frame, and a single-memory apply that the bulk `syncMemories` lacks. Conflict (keep-both)
 * is deferred to M4.1 — private-mind/git remains the conflict authority for now (adopt-newest here).
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter, upsertEntry, memoryHome } from './sync.js'
import { getEmbeddingMode, embedText } from '../embeddings.js'
import { putEmbedding } from '../embeddingStore.js'
import { get, run, all, transaction } from './db.js'
import { nodeId } from '../bus/meshIdentity.js'

export const hashContent = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')

/** repo path (memory/user/foo.md | memory/user-concepts/foo.md | memory/proj/<enc>/foo.md) → local abs path. */
export function repoToLocalMemoryPath(repoPath: string): string | null {
  const parts = repoPath.split('/')
  if (parts[0] !== 'memory') return null
  const home = memoryHome()
  if (parts[1] === 'user' && parts.length === 3) return path.join(home, '.claude', 'memory', parts[2]!)
  if (parts[1] === 'user-concepts' && parts.length === 3) return path.join(home, '.claude', 'memory', 'concepts', parts[2]!)
  if (parts[1] === 'proj' && parts.length === 4) return path.join(home, '.claude', 'projects', parts[2]!, 'memory', parts[3]!)
  return null
}

/** local abs path → repo path (inverse of repoToLocalMemoryPath). null when outside the memory tree. */
export function localToRepoMemoryPath(abs: string): string | null {
  const home = memoryHome()
  const userMem = path.join(home, '.claude', 'memory')
  const concepts = path.join(userMem, 'concepts')
  if (path.dirname(abs) === concepts) return `memory/user-concepts/${path.basename(abs)}`
  if (path.dirname(abs) === userMem) return `memory/user/${path.basename(abs)}`
  const projects = path.join(home, '.claude', 'projects')
  const rel = path.relative(projects, abs).split(path.sep)
  if (rel.length === 3 && rel[1] === 'memory') return `memory/proj/${rel[0]}/${rel[2]}`
  return null
}

/** Write one memory's .md locally + upsert its graph entry. The single-memory apply syncMemories lacks. */
export async function applyMemory(repoPath: string, content: string): Promise<void> {
  const lp = repoToLocalMemoryPath(repoPath)
  if (!lp) return
  await fs.mkdir(path.dirname(lp), { recursive: true })
  await fs.writeFile(lp, content, 'utf8')
  const { data, body } = parseFrontmatter(content)
  const id = data.id ? String(data.id) : repoPath
  upsertEntry(null, {
    id,
    name: String(data.name ?? path.basename(lp, '.md')),
    kind: String(data.type ?? data.kind ?? 'memory'),
    description: String(data.description ?? ''),
    content: body.slice(0, 8192),
    source: lp,
    scope: String(data.scope ?? 'user'),
    updatedAt: Date.now(),
    authorship: String(data.authorship ?? 'auto-extracted'),
    outcome: String(data.outcome ?? ''),
    outcomeText: String(data.outcome_text ?? ''),
    agentId: String(data.agent_id ?? ''),
    sessionId: String(data.session_id ?? ''),
    pinned: data.pinned === true || data.pinned === 'true',
    machine: data.machine ? String(data.machine) : '',
  })
  if (getEmbeddingMode() !== 'off') {
    try { const v = await embedText(`${data.name ?? ''} ${data.description ?? ''} ${body}`); if (v) await putEmbedding(id, v) } catch { /* best-effort */ }
  }
}

export interface MeshMemory {
  id: string; repoPath: string; scope: string; content: string; contentHash: string
  machine: string; originNode: string; memSeq: number; deletedAt: number
}

type MemListener = (m: MeshMemory, fromPeerNode?: string) => void
const memListeners = new Set<MemListener>()
export function onBusMemory(fn: MemListener): () => void { memListeners.add(fn); return () => memListeners.delete(fn) }
export function emitBusMemory(m: MeshMemory, fromPeerNode?: string): void { for (const fn of memListeners) fn(m, fromPeerNode) }

export function bumpMemSeq(node: string): number {
  return transaction(() => {
    run(`INSERT INTO mem_seq_counter (node, seq) VALUES (?, 1) ON CONFLICT(node) DO UPDATE SET seq = seq + 1`, node)
    return Number(get<{ seq: number }>(`SELECT seq FROM mem_seq_counter WHERE node = ?`, node)?.seq ?? 1)
  })
}
export function getMemCursor(peerNode: string): number {
  return Number(get<{ last_seq: number }>(`SELECT last_seq FROM mem_cursors WHERE peer_node = ?`, peerNode)?.last_seq ?? 0)
}
export function setMemCursor(peerNode: string, seq: number): void {
  run(`INSERT INTO mem_cursors (peer_node, last_seq, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(peer_node) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
     peerNode, seq, Date.now())
}
const rowToMem = (r: any): MeshMemory => ({ id: r.id, repoPath: r.repo_path, scope: r.scope,
  content: r.content, contentHash: r.content_hash, machine: r.machine, originNode: r.origin_node,
  memSeq: Number(r.mem_seq), deletedAt: Number(r.deleted_at) })

/** Local memory write → stamp origin+seq, upsert mem_log, emit (only when content changed). */
export function recordLocalMemory(in_: { id: string; repoPath: string; scope: string; content: string; machine: string; deletedAt?: number }): { emitted: boolean } {
  const hash = hashContent(in_.content)
  const prior = get<{ content_hash: string }>(`SELECT content_hash FROM mem_log WHERE id = ?`, in_.id)
  if (prior && prior.content_hash === hash && !in_.deletedAt) return { emitted: false }
  const origin = nodeId()
  let row!: MeshMemory
  transaction(() => {
    const seq = bumpMemSeq(origin)
    run(`INSERT INTO mem_log (id, repo_path, scope, content, content_hash, machine, origin_node, mem_seq, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET repo_path=excluded.repo_path, scope=excluded.scope, content=excluded.content,
           content_hash=excluded.content_hash, machine=excluded.machine, origin_node=excluded.origin_node,
           mem_seq=excluded.mem_seq, deleted_at=excluded.deleted_at`,
       in_.id, in_.repoPath, in_.scope, in_.content, hash, in_.machine, origin, seq, in_.deletedAt ?? 0)
    row = rowToMem(get<any>(`SELECT * FROM mem_log WHERE id = ?`, in_.id))
  })
  emitBusMemory(row)
  return { emitted: true }
}

/**
 * Ingest a peer memory: grow-only, preserve sender origin/seq, apply (or tombstone), re-emit to flood-forward.
 *
 * DELIBERATE DIVERGENCE from the bus mirror (`ingestMeshMessage` emits ONLY on
 * fresh insert — bus.ts:631 `if (inserted)`): a memory is content-VERSIONED, so a
 * real edit (same id, new content/hash) MUST flood-forward or peers silently keep
 * the stale version. Hence we emit on both fresh-insert AND content-change, and
 * gate ONLY on identical content (`prior.content_hash === hash` early-returns).
 * That content-hash check is the loop terminator: a memory that has already
 * converged to this hash on a peer re-floods nothing, so the flood is finite.
 * Do NOT "fix" this back to insert-only — that would drop edit propagation. (A bus
 * `msg` is immutable post-create, so its insert-only gate is correct for ITS tier;
 * the two tiers differ on purpose. See M4 design doc "fresh-insert-only emit gate".)
 */
export async function ingestMeshMemory(mem: MeshMemory, lastHopNode?: string): Promise<void> {
  const hash = mem.contentHash || hashContent(mem.content)
  const prior = get<{ content_hash: string }>(`SELECT content_hash FROM mem_log WHERE id = ?`, mem.id)
  if (prior && prior.content_hash === hash) return // idempotent — already have this version (loop terminator)
  run(`INSERT INTO mem_log (id, repo_path, scope, content, content_hash, machine, origin_node, mem_seq, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET repo_path=excluded.repo_path, scope=excluded.scope, content=excluded.content,
         content_hash=excluded.content_hash, machine=excluded.machine, origin_node=excluded.origin_node,
         mem_seq=excluded.mem_seq, deleted_at=excluded.deleted_at`,
     mem.id, mem.repoPath, mem.scope, mem.content, hash, mem.machine, mem.originNode, mem.memSeq, mem.deletedAt)
  if (mem.deletedAt) {
    const lp = repoToLocalMemoryPath(mem.repoPath)
    if (lp) { try { await fs.rm(lp, { force: true }) } catch { /* gone */ } }
    run(`DELETE FROM entries WHERE id = ?`, mem.id)
  } else {
    await applyMemory(mem.repoPath, mem.content)
  }
  emitBusMemory(rowToMem(get<any>(`SELECT * FROM mem_log WHERE id = ?`, mem.id)), lastHopNode)
}

export function memoriesOriginatedSince(after: number, limit = 200): MeshMemory[] {
  return all<any>(`SELECT * FROM mem_log WHERE origin_node = ? AND mem_seq > ? ORDER BY mem_seq ASC LIMIT ?`,
    nodeId(), after, limit).map(rowToMem)
}
