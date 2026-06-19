/**
 * Sidecar storage for entry embeddings.
 *
 * Lives outside the graph DB so the graph stays portable and we don't depend
 * on graph-engine vector indexes. Two files:
 *
 *   ~/.config/ckn/embeddings/manifest.json — { ids: string[], dim, version }
 *   ~/.config/ckn/embeddings/vectors.bin   — flat Float32Array (id_count × dim)
 *
 * Vector for `ids[i]` lives at offset `i * dim` in vectors.bin. Adding a
 * new vector appends to both files atomically. Removing one rewrites
 * (cheap at our scale; we expect O(10K) entries max).
 *
 * In-memory: the entire vector store is loaded once on first read into
 * a Map keyed by id → Float32Array. Mutations write through to disk.
 * Brute-force cosine over 10K × 384 floats is < 5 ms — no index needed.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { cosine, getEmbeddingDim } from './embeddings.js'

const STORE_DIR = path.join(os.homedir(), '.config', 'ckn', 'embeddings')
const MANIFEST_PATH = path.join(STORE_DIR, 'manifest.json')
const VECTORS_PATH = path.join(STORE_DIR, 'vectors.bin')

interface Manifest {
  version: 1
  dim: number
  ids: string[]
}

let _store: Map<string, Float32Array> | null = null
let _dirty = false

/**
 * Load the sidecar from disk. Idempotent — caches the in-memory store.
 * Mismatched dim (e.g. previous run used a different model) is treated
 * as "stale" and the store is reset to empty; fresh embeddings will
 * repopulate on next sync.
 */
const loadStore = async (): Promise<Map<string, Float32Array>> => {
  if (_store) return _store
  _store = new Map()

  let manifest: Manifest | null = null
  try {
    const raw = await fsp.readFile(MANIFEST_PATH, 'utf-8')
    manifest = JSON.parse(raw) as Manifest
  } catch {
    return _store
  }
  if (!manifest || manifest.version !== 1) return _store
  if (manifest.dim !== getEmbeddingDim()) {
    console.warn(
      `[ckn embeddings] sidecar dim mismatch (manifest=${manifest.dim} expected=${getEmbeddingDim()}) — resetting store`,
    )
    return _store
  }

  let buf: Buffer
  try {
    buf = await fsp.readFile(VECTORS_PATH)
  } catch {
    return _store
  }
  const expectedBytes = manifest.ids.length * manifest.dim * 4
  if (buf.length < expectedBytes) {
    console.warn(
      `[ckn embeddings] sidecar truncation (${buf.length} bytes; expected ${expectedBytes}) — resetting`,
    )
    return _store
  }

  // Slice into per-id Float32Arrays. Copy each slice so we own its
  // buffer and can drop the giant raw buffer afterwards.
  const floats = new Float32Array(buf.buffer, buf.byteOffset, manifest.ids.length * manifest.dim)
  for (let i = 0; i < manifest.ids.length; i++) {
    const start = i * manifest.dim
    const end = start + manifest.dim
    _store.set(manifest.ids[i]!, new Float32Array(floats.slice(start, end)))
  }
  return _store
}

/** Persist the in-memory store to disk. Atomic via tempfile + rename. */
const doFlush = async (): Promise<void> => {
  if (!_store || !_dirty) return
  try {
    await fsp.mkdir(STORE_DIR, { recursive: true })
    const dim = getEmbeddingDim()
    const ids = Array.from(_store.keys())
    const buf = Buffer.alloc(ids.length * dim * 4)
    const view = new Float32Array(buf.buffer, buf.byteOffset, ids.length * dim)
    for (let i = 0; i < ids.length; i++) {
      const vec = _store.get(ids[i]!)!
      view.set(vec, i * dim)
    }
    const manifest: Manifest = { version: 1, dim, ids }
    // Atomic write: temp + rename so a crash mid-write doesn't corrupt the
    // manifest/vectors pair. Per-pid temp names as extra insurance against a
    // stale sibling tempfile.
    const tmpManifest = `${MANIFEST_PATH}.${process.pid}.tmp`
    const tmpVectors = `${VECTORS_PATH}.${process.pid}.tmp`
    await fsp.writeFile(tmpManifest, JSON.stringify(manifest), 'utf-8')
    await fsp.writeFile(tmpVectors, buf)
    await fsp.rename(tmpManifest, MANIFEST_PATH)
    await fsp.rename(tmpVectors, VECTORS_PATH)
    _dirty = false
  } catch (e) {
    // Embeddings are a regenerable cache — a flush failure must NEVER crash the
    // server (scheduleFlush calls `void flush()`, so a rejection is unhandled).
    // Log and keep _dirty so the next scheduled flush retries.
    console.error('[ckn] embedding flush failed (will retry):', (e as Error)?.message ?? e)
  }
}

// Serialize flushes. Concurrent callers (the debounced timer, shutdown hooks,
// post-sync writes) previously raced on a shared temp path — overlapping
// renames threw an uncaught ENOENT that killed the process. Chaining keeps
// writes strictly sequential and the manifest/vectors pair consistent.
let _flushChain: Promise<void> = Promise.resolve()
const flush = (): Promise<void> => {
  _flushChain = _flushChain.then(doFlush, doFlush)
  return _flushChain
}

// Debounced flush — multiple putEmbedding calls in a single sync collapse
// to one write. Tail of the latest set wins.
let _flushTimer: NodeJS.Timeout | null = null
const scheduleFlush = (): void => {
  if (_flushTimer) clearTimeout(_flushTimer)
  _flushTimer = setTimeout(() => {
    void flush()
  }, 500)
}

/** Store a vector for an entry id. Replaces existing on collision. */
export const putEmbedding = async (id: string, vec: Float32Array): Promise<void> => {
  const store = await loadStore()
  store.set(id, vec)
  _dirty = true
  scheduleFlush()
}

/** Remove an entry's embedding. No-op when absent. */
export const removeEmbedding = async (id: string): Promise<void> => {
  const store = await loadStore()
  if (store.delete(id)) {
    _dirty = true
    scheduleFlush()
  }
}

/** Force flush — used on shutdown / explicit fsync. */
export const flushEmbeddings = async (): Promise<void> => {
  if (_flushTimer) {
    clearTimeout(_flushTimer)
    _flushTimer = null
  }
  await flush()
}

export interface SimilarHit {
  id: string
  score: number
}

/**
 * Brute-force top-K cosine search. At our scale (≤10K entries × 384 dim),
 * this is sub-5ms. When the store grows past that, swap in a real index.
 *
 * Returns hits sorted by descending score. `minScore` defaults to 0.0 —
 * cosine ranges from -1 to 1; for normalized BGE outputs, even barely-
 * related text tends to score around 0.3, so callers may want to apply
 * a threshold of ~0.4-0.5.
 */
export const searchSimilar = async (
  query: Float32Array,
  k: number = 10,
  minScore: number = 0,
): Promise<SimilarHit[]> => {
  const store = await loadStore()
  if (store.size === 0) return []
  const hits: SimilarHit[] = []
  for (const [id, vec] of store) {
    const score = cosine(query, vec)
    if (score < minScore) continue
    hits.push({ id, score })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, k)
}

/** Number of vectors currently in the store. Used by status endpoints. */
export const embeddingCount = async (): Promise<number> => {
  const store = await loadStore()
  return store.size
}

/** The set of entry ids that currently have a stored vector. #123: the sync
 *  fast-paths consult this so an entry is skipped as "unchanged" ONLY when it is
 *  also already embedded — otherwise a deferred/failed embed would strand it
 *  permanently unsearchable behind a content_hash match. */
export const embeddedIdSet = async (): Promise<Set<string>> => {
  const store = await loadStore()
  return new Set(store.keys())
}
