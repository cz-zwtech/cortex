/**
 * sync_manifest — per-file (mtime, size) stat cache for the sync pre-pass
 * (commit-2 sync floor).
 *
 * The pre-pass in `syncMemories` used to read + sha256 every memory file each
 * run purely to detect change — at ~2.5k files on a /mnt-WSL mount that is the
 * residual ~4s after commit-1 removed the O(N²) name-mention scan. This sidecar
 * records each file's (mtime, size) at sync time so the next pre-pass can SKIP
 * opening a file whose stat is unchanged.
 *
 * IMPORTANT — stat is only the FAST PATH, not the source of truth: it decides
 * WHICH files to open. For files it does open (stat changed, or new), the
 * `entries.content_hash` delta-check stays authoritative.
 *
 * #146: the gate is (mtime, size, ctime). The old (mtime, size) gate false-
 * skipped a same-size body edit whose mtime was preserved (atomic-rename editors
 * that restore mtime) — the content change was never re-hashed and was silently
 * dropped. ctime closes that hole: a content write always bumps ctime, and ctime
 * cannot be set via utimes, so even an mtime-restoring editor's write is caught,
 * while a truly untouched file keeps a stable ctime and still skips.
 */
import { all, run, transaction } from './db.js'

export interface FileStat {
  mtime: number
  size: number
  /** ctime (inode-change time) in ms. NULL = a legacy row written before the
   *  #146 migration; statUnchanged treats it as "must read" so a one-time
   *  re-read backfills it. */
  ctime: number | null
}

/** Load the whole manifest into a path → {mtime,size,ctime} map. */
export function readSyncManifest(): Map<string, FileStat> {
  const rows = all<{ path: string; mtime: number; size: number; ctime: number | null }>(
    'SELECT path, mtime, size, ctime FROM sync_manifest',
  )
  const m = new Map<string, FileStat>()
  for (const r of rows) m.set(r.path, { mtime: r.mtime, size: r.size, ctime: r.ctime })
  return m
}

/**
 * True iff `path` is in the manifest with the SAME (mtime,size,ctime) — i.e. the
 * file can be skipped without reading.
 *
 * #146: ctime is part of the gate. A content write ALWAYS bumps ctime (and ctime
 * cannot be set via utimes), so a same-size body edit with a preserved mtime —
 * which the old (mtime,size) gate false-skipped — now differs on ctime and is
 * read + re-hashed. A truly untouched file keeps a stable ctime and still skips.
 * A NULL stored ctime (legacy pre-migration row) is treated as NOT unchanged, so
 * we fail toward reading and backfill ctime on the next sync. Absent path → false.
 */
export function statUnchanged(
  path: string,
  mtime: number,
  size: number,
  ctime: number,
  manifest: Map<string, FileStat>,
): boolean {
  const e = manifest.get(path)
  if (e === undefined) return false
  if (e.ctime == null) return false // legacy row — fail toward reading
  return e.mtime === mtime && e.size === size && e.ctime === ctime
}

/** Upsert the given files' (mtime,size,ctime). One transaction for the batch. */
export function writeSyncManifest(
  entries: Array<{ path: string; mtime: number; size: number; ctime: number }>,
): void {
  if (entries.length === 0) return
  transaction(() => {
    for (const e of entries) {
      run(
        'INSERT OR REPLACE INTO sync_manifest (path, mtime, size, ctime) VALUES (?, ?, ?, ?)',
        e.path,
        e.mtime,
        e.size,
        e.ctime,
      )
    }
  })
}
