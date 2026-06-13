import { fs, join, readJsonOrNull } from '@/adapters'

/**
 * Generic per-path cache, keyed by `(mtime, size)`, persisted to disk.
 *
 * Each namespace backs a single JSON file under `~/.config/ckn/` and holds
 * an opaque value type chosen by the caller. Hits happen iff the stamp
 * matches; mismatches (a file was edited since last parse) return null.
 *
 * Adapters declare one cache at module load via {@link createPersistentCache};
 * the store calls {@link initPersistentCaches} during bootstrap to hydrate
 * every registered namespace in parallel. Writes are batched via a per-cache
 * debounced flush so an enrichment sweep doesn't thrash the disk.
 *
 * `invalidatePath` is the cross-namespace eviction hook wired to `fs:change`.
 *
 * Disk layout is versioned — bump {@link CACHE_VERSION} to invalidate every
 * cache file on next launch. Use this when the shape of any cached value
 * changes in a way that would confuse current code (e.g. a schema migration
 * or a bug fix that might have persisted malformed entries).
 */

/**
 * On-disk schema version. Increment when a prior release may have written
 * values that current code can't safely consume.
 *
 * History:
 *   1 — initial.
 *   2 — 0.2.x persisted failed-parse entities with `{} as T` value; bumping
 *       forces a clean rebuild so stale broken entries don't crash editors.
 */
const CACHE_VERSION = 2

export interface FileStamp {
  mtime: number
  size: number
}

interface StoredEntry<T = unknown> extends FileStamp {
  value: T
}

interface DiskShape {
  version: number
  entries: Record<string, StoredEntry>
}

interface Namespace {
  name: string
  store: Map<string, StoredEntry>
  saveTimer: ReturnType<typeof setTimeout> | null
}

const FLUSH_MS = 500

const namespaces: Namespace[] = []
let home = ''

const fileOf = (ns: Namespace, h: string): string =>
  join(h, '.config', 'ckn', `${ns.name}.cache.json`)

const scheduleFlush = (ns: Namespace): void => {
  if (!home) return
  if (ns.saveTimer) clearTimeout(ns.saveTimer)
  ns.saveTimer = setTimeout(() => {
    ns.saveTimer = null
    const entries: Record<string, StoredEntry> = {}
    for (const [p, e] of ns.store) entries[p] = e
    const payload: DiskShape = { version: CACHE_VERSION, entries }
    void fs.writeJson(fileOf(ns, home), payload)
  }, FLUSH_MS)
}

export interface PersistentCache<T> {
  get(path: string, stamp: FileStamp): T | null
  set(path: string, stamp: FileStamp, value: T): void
  invalidate(path: string): void
}

export const createPersistentCache = <T>(name: string): PersistentCache<T> => {
  const ns: Namespace = { name, store: new Map(), saveTimer: null }
  namespaces.push(ns)
  return {
    get(path, stamp) {
      const hit = ns.store.get(path)
      if (!hit) return null
      if (hit.mtime !== stamp.mtime || hit.size !== stamp.size) return null
      return hit.value as T
    },
    set(path, stamp, value) {
      ns.store.set(path, { mtime: stamp.mtime, size: stamp.size, value })
      scheduleFlush(ns)
    },
    invalidate(path) {
      if (ns.store.delete(path)) scheduleFlush(ns)
    },
  }
}

/**
 * Hydrate every registered namespace from disk. Called once at bootstrap.
 * Files whose recorded version doesn't match {@link CACHE_VERSION} are
 * treated as empty — the next flush overwrites them with the current format.
 */
export const initPersistentCaches = async (userHome: string): Promise<void> => {
  home = userHome
  await Promise.all(
    namespaces.map(async (ns) => {
      const raw = await readJsonOrNull<DiskShape>(fileOf(ns, home))
      if (!raw || raw.version !== CACHE_VERSION || !raw.entries) {
        ns.store = new Map()
        return
      }
      ns.store = new Map(Object.entries(raw.entries))
    }),
  )
}

/** Evict `path` from every registered cache (used by the fs watcher). */
export const invalidatePath = (path: string): void => {
  for (const ns of namespaces) {
    if (ns.store.delete(path)) scheduleFlush(ns)
  }
}
