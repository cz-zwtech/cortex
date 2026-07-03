/**
 * Cortex embeddings layer — Phase 3.
 *
 * Three modes selected via CKN_EMBEDDINGS:
 *   local   (default)  — bge-small-en-v1.5 via @huggingface/transformers
 *                        Model downloads on first use to ~/.cache/huggingface/.
 *                        ~33 MB on disk, ~150 MB RAM resident, ~30 ms/embedding
 *                        on a modern CPU.
 *   remote              — call out to Voyage / OpenAI / etc. Requires
 *                        CKN_EMBED_API_KEY. Stub for now; lights up later.
 *   off                — substring search continues to work; no semantic
 *                        recall. The right choice on tiny VPSs / air-gapped
 *                        boxes / Alpine.
 *
 * Failure to load the local model in `local` mode degrades silently to
 * `off` — the rest of Cortex keeps functioning. The mode is decided once
 * at module load and cached; restart the server to change it.
 *
 * Storage lives in `embeddingStore.ts` — vectors are kept in a sidecar
 * file outside the graph DB so the graph stays portable and doesn't depend
 * on graph-engine vector indexes.
 */
import { Worker } from 'node:worker_threads'

export type EmbeddingMode = 'local' | 'remote' | 'off'

const EMBEDDING_DIM = 384

let _mode: EmbeddingMode | null = null

// Truthy aliases people reach for instead of the canonical 'local'. Mapping
// them (rather than fail-safing to 'off') fixes #139 B — CKN_EMBEDDINGS=on used
// to silently disable embeddings on a node the user meant to turn ON.
const LOCAL_ALIASES = new Set(['on', 'true', '1'])

/**
 * Normalize a raw CKN_EMBEDDINGS value to a mode. Canonical modes
 * (local|remote|off) pass through; truthy aliases (on|true|1) map to 'local';
 * anything unrecognized is 'off' (fail-safe). Case- and whitespace-insensitive.
 * Pure — no env read, no cache — so the mapping is unit-testable.
 */
export const normalizeEmbeddingMode = (raw: string): EmbeddingMode => {
  const v = (raw ?? '').toLowerCase().trim()
  if (v === 'local' || v === 'remote' || v === 'off') return v
  if (LOCAL_ALIASES.has(v)) return 'local'
  return 'off'
}

/**
 * Decide the active mode. Reads CKN_EMBEDDINGS once and caches. Defaults
 * to 'local' when unset. Truthy aliases normalize to 'local'; an unrecognized
 * value fails safe to 'off' but warns once, so a typo doesn't silently disable
 * embeddings (the #139 footgun class).
 */
export const getEmbeddingMode = (): EmbeddingMode => {
  if (_mode !== null) return _mode
  const raw = process.env.CKN_EMBEDDINGS ?? 'local'
  const mode = normalizeEmbeddingMode(raw)
  if (mode === 'off' && raw.toLowerCase().trim() !== 'off') {
    console.warn(
      `[ckn embeddings] CKN_EMBEDDINGS='${raw}' not recognized — using 'off'. ` +
        `Valid: local | remote | off (on/true/1 -> local).`,
    )
  }
  _mode = mode
  return _mode
}

export const getEmbeddingDim = (): number => EMBEDDING_DIM

// ── worker-thread inference ──────────────────────────────────────────────────
// The model load (~800 ms) and inference (~10 ms warm) are CPU-bound and run
// on the WASM ORT backend, which executes synchronously on whatever thread it's
// on. Running it on the server's single event loop is what wedged the server:
// every /api/recall fires an embed, on every tool call, across all live
// sessions' hooks — the loop saturates and stops accepting connections (the
// "hang"). Fix: run the model in a dedicated worker thread (embeddingWorker.mjs)
// so the event loop only does microsecond message-passing and stays responsive
// no matter the embedding load.
//
// A bounded mailbox (EMBED_MAX_QUEUE) is still kept: past that many in-flight
// requests, new calls return null immediately so the worker backlog can't grow
// without bound. Callers (graphRecall et al.) degrade to substring/graph recall
// on a null vector.
const EMBED_MAX_QUEUE = Math.max(1, Number(process.env.CKN_EMBED_MAX_QUEUE ?? '6'))

/** The worker's in-flight cap — also the safe batch size for a parallel embed
 *  backfill (#123): a chunk this size keeps `embedText` from returning null on a
 *  full mailbox, since each chunk fully drains before the next starts. */
export const embedConcurrency = (): number => EMBED_MAX_QUEUE

type Pending = { resolve: (v: Float32Array | null) => void }
let _worker: Worker | null = null
let _workerFailed = false
let _nextId = 1
const _pending = new Map<number, Pending>()

const resolveAllPending = (v: Float32Array | null) => {
  for (const p of _pending.values()) p.resolve(v)
  _pending.clear()
}

/** Lazily spawn the embedding worker (singleton). Returns null if spawn fails. */
const getWorker = (): Worker | null => {
  if (_worker) return _worker
  if (_workerFailed) return null
  try {
    const worker = new Worker(new URL('./embeddingWorker.mjs', import.meta.url))
    worker.on('message', (m: { id: number; ok: boolean; buf?: ArrayBuffer; error?: string }) => {
      const p = _pending.get(m.id)
      if (!p) return
      _pending.delete(m.id)
      if (m.ok && m.buf) {
        p.resolve(new Float32Array(m.buf))
      } else {
        console.warn(`[ckn embeddings] worker embed failed: ${m.error ?? 'unknown'}`)
        p.resolve(null)
      }
    })
    // On crash/exit: fail every in-flight request to null (callers degrade) and
    // drop the handle so the next embedText() respawns a fresh worker.
    const onDown = (why: string) => {
      console.warn(`[ckn embeddings] worker down (${why}); respawning on next use`)
      _worker = null
      resolveAllPending(null)
    }
    worker.on('error', (e) => onDown(String(e?.message ?? e)))
    worker.on('exit', (code) => { if (code !== 0) onDown(`exit ${code}`) })
    // Don't keep short-lived bin/* processes alive on the worker thread; the
    // long-lived server is unaffected by unref.
    worker.unref()
    _worker = worker
    return worker
  } catch (e: any) {
    _workerFailed = true
    console.warn(
      `[ckn embeddings] worker spawn failed — degrading to 'off'. Reason: ${String(e?.message ?? e)}`,
    )
    _mode = 'off'
    return null
  }
}

/**
 * Embed a single string. Returns null when embeddings are disabled or
 * the model isn't available. Callers must handle null gracefully — we
 * never want a missing embedding to crash the sync pipeline.
 *
 * Input is truncated at the model's effective limit (512 tokens ≈ 2000
 * chars for English). Longer text gets the head; semantic content is
 * usually front-loaded in our memory bodies anyway (name + description
 * + first paragraph). All inference happens off the event loop in
 * embeddingWorker.mjs.
 */
export const embedText = async (text: string): Promise<Float32Array | null> => {
  const mode = getEmbeddingMode()
  if (mode === 'off') return null
  if (mode === 'remote') {
    // Stub for now — wired in a future commit. Falling back to 'off'
    // semantics until then so callers degrade cleanly.
    return null
  }
  const trimmed = (text ?? '').slice(0, 2000)
  if (!trimmed.trim()) return null
  // Shed load: bounded worker mailbox. A request storm returns null fast rather
  // than queueing without bound.
  if (_pending.size >= EMBED_MAX_QUEUE) return null
  const worker = getWorker()
  if (!worker) return null
  const id = _nextId++
  return new Promise<Float32Array | null>((resolve) => {
    _pending.set(id, { resolve })
    try {
      worker.postMessage({ id, text: trimmed })
    } catch (e: any) {
      _pending.delete(id)
      console.warn(`[ckn embeddings] postMessage failed: ${String(e?.message ?? e)}`)
      resolve(null)
    }
  })
}

/**
 * Warm the model in the worker so the first real recall isn't paying the
 * ~800 ms cold-load latency. Fire-and-forget; safe to call at server boot.
 * No-op when embeddings are off/remote.
 */
export const warmEmbeddings = (): void => {
  if (getEmbeddingMode() !== 'local') return
  void embedText('warmup').catch(() => {})
}

/**
 * Compose the canonical text representation of an entry to embed. We
 * front-load name + description because BGE truncates at 512 tokens and
 * the most semantically dense signal lives there. Body is appended for
 * long-tail context.
 */
export const embeddingTextForEntry = (entry: {
  name?: string
  description?: string
  content?: string
}): string => {
  const parts = [entry.name ?? '', entry.description ?? '', (entry.content ?? '').slice(0, 1000)]
  return parts.filter((p) => p && p.trim()).join('\n\n')
}

/**
 * Cosine similarity between two unit-normalized vectors. BGE outputs are
 * normalized when we pass `normalize: true`, so this reduces to dot
 * product. Kept as a separate function in case future models don't
 * normalize.
 */
export const cosine = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot
}
