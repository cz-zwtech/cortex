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
 * `entries.content_hash` delta-check stays authoritative, so a body edit that
 * changes content (hence size, and almost always mtime) is still caught. The
 * only thing skipped is a same-mtime AND same-size content swap — negligible.
 * The airtight-but-bigger alternative (consume the chokidar dirty-set) is a
 * future option; mtime+size is the proportionate cure.
 */
import { all, run, transaction } from './db.js'

export interface FileStat {
  mtime: number
  size: number
}

/** Load the whole manifest into a path → {mtime,size} map. */
export function readSyncManifest(): Map<string, FileStat> {
  const rows = all<{ path: string; mtime: number; size: number }>(
    'SELECT path, mtime, size FROM sync_manifest',
  )
  const m = new Map<string, FileStat>()
  for (const r of rows) m.set(r.path, { mtime: r.mtime, size: r.size })
  return m
}

/** True iff `path` is in the manifest with the SAME (mtime,size) — i.e. the
 *  file can be skipped without reading. Absent path (new file) → false. */
export function statUnchanged(
  path: string,
  mtime: number,
  size: number,
  manifest: Map<string, FileStat>,
): boolean {
  const e = manifest.get(path)
  return e !== undefined && e.mtime === mtime && e.size === size
}

/** Upsert the given files' (mtime,size). One transaction for the batch. */
export function writeSyncManifest(entries: Array<{ path: string; mtime: number; size: number }>): void {
  if (entries.length === 0) return
  transaction(() => {
    for (const e of entries) {
      run(
        'INSERT OR REPLACE INTO sync_manifest (path, mtime, size) VALUES (?, ?, ?)',
        e.path,
        e.mtime,
        e.size,
      )
    }
  })
}
