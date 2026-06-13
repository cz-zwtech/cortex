/**
 * Cortex embedding worker — runs the bge-small-en-v1.5 model on a dedicated
 * thread so model load (~800 ms) and inference (~10 ms warm) NEVER block the
 * server's single event loop.
 *
 * Why this is a plain `.mjs` and not `.ts`: worker threads are spawned with a
 * fresh module loader. Under `tsx`, the parent's TypeScript loader is NOT
 * inherited by the worker (passing `--import tsx` via execArgv does not
 * reliably register it), so a `.ts` worker fails with "Unknown file extension".
 * A native ESM `.mjs` is loaded by Node directly in both dev (`tsx watch`) and
 * prod (`tsx`) with no loader at all — the robust, environment-independent path.
 *
 * Protocol: parent posts { id, text }; worker replies
 *   { id, ok: true, buf }   — buf is a transferred ArrayBuffer (Float32Array)
 *   { id, ok: false, error } — model load or inference failed; caller degrades
 *                              to non-semantic recall.
 * The model is loaded lazily on the first message and cached for the worker's
 * lifetime.
 */
import { parentPort } from 'node:worker_threads'
import * as path from 'node:path'
import * as os from 'node:os'

const MODEL_ID = 'Xenova/bge-small-en-v1.5'

// Cached model-load promise. A rejection stays cached so a broken install
// fast-fails every subsequent message instead of re-attempting the load.
let _extractorP = null

const loadExtractor = () => {
  if (_extractorP) return _extractorP
  _extractorP = (async () => {
    const transformers = await import('@huggingface/transformers')
    // Route the model cache out of node_modules so npm install doesn't wipe the
    // download. Mirrors the Python convention so the model is shared across the
    // Python + JS clients. Identical to the previous in-process logic.
    const xdgCache = process.env.XDG_CACHE_HOME
    const cacheDir = xdgCache
      ? path.join(xdgCache, 'huggingface', 'hub')
      : path.join(os.homedir(), '.cache', 'huggingface', 'hub')
    transformers.env.cacheDir = cacheDir
    const extractor = await transformers.pipeline('feature-extraction', MODEL_ID, {
      dtype: 'fp32',
    })
    return extractor
  })()
  return _extractorP
}

if (!parentPort) {
  throw new Error('embeddingWorker.mjs must be run as a worker thread')
}

parentPort.on('message', async (msg) => {
  const { id, text } = msg ?? {}
  try {
    const extractor = await loadExtractor()
    const output = await extractor(text, { pooling: 'mean', normalize: true })
    // Copy into a fresh, owned ArrayBuffer and transfer it (zero-copy hand-off).
    const arr = Float32Array.from(output.data)
    parentPort.postMessage({ id, ok: true, buf: arr.buffer }, [arr.buffer])
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message ?? e) })
  }
})
