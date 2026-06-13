/**
 * s3 — EDITED_IN derivation (Option C: transcript-derived at sync).
 *
 * The "acted-on" corroboration signal needs a truthful record of "session S
 * edited file F". We derive it from the session transcript's Edit/Write/MultiEdit
 * tool_use events (Path-B-safe — transcripts exist regardless of the API-key auth
 * mode, unlike session.mentions_files which only Path-A extraction stamps) at sync
 * time (consistent with §5.3 derive-at-sync; zero edit-hot-path cost; rebuildable
 * from disk). The edge is `file → session`, OBSERVATIONAL (see OBSERVATIONAL_RELS
 * in sync.ts), `weight` = edit count, `notedAt` = last edit (D3 reads this),
 * `firstAt` = first edit (set-on-insert, never bumped). See
 * /personal/docs/cortex/s3-acted-on-correlation-proposal.md.
 *
 * This module is the JOIN-AGNOSTIC half: it stores the edge keyed on the verbatim
 * (usually absolute) transcript path via `fileEntryId`. Bridging that to the
 * §5.3 MENTIONS_FILE prose path (relative/partial/cross-machine) is the detector's
 * job (acted-on `pathSuffixMatch`), not this module's — here we record exactly
 * what was edited.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import { run, transaction, get } from './db.js'
import { statUnchanged, type FileStat } from './syncManifest.js'
import { ensureStubEntry, fileEntryId } from './sync.js'

/** Tool names that constitute a file edit (r1 — a successful one of these). */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

export interface EditedFile {
  /** Verbatim file_path from the edit tool_use (kept as-written, so the file
   *  node `name` matches what other derivations store). */
  path: string
  /** Number of SUCCESSFUL edits to this file in the transcript. */
  count: number
  /** Earliest successful-edit time, ms (firstAt — set-on-insert). */
  firstAt: number
  /** Latest successful-edit time, ms (notedAt / lastEditAt — D3 reads this). */
  lastAt: number
}

/** Parse an ISO timestamp to ms; 0 when absent/unparseable (never NaN). */
const tsMs = (iso: unknown): number => {
  const t = Date.parse(String(iso ?? ''))
  return Number.isFinite(t) ? t : 0
}

/**
 * Pure r1 core. From a session transcript's raw JSONL text, return the files
 * SUCCESSFULLY edited — an Edit/Write/MultiEdit tool_use whose matching
 * tool_result is present and NOT `is_error` — aggregated per file with edit
 * count + first/last edit time.
 *
 * "Successful" requires a non-error result: an errored edit (the file was NOT
 * changed) and a result-less edit (in-flight at sync time — picked up on the
 * next sync once its result lands, per r2) are both excluded. The edit time is
 * the tool_use record's timestamp (when the edit was issued), falling back to
 * the result's timestamp if the tool_use carried none.
 */
export function parseEditedFiles(rawJsonl: string): EditedFile[] {
  // toolUseId → the pending edit's (path, issue-time) until its result confirms it.
  const pending = new Map<string, { path: string; ts: number }>()
  // verbatim path → aggregated successful-edit stats (insertion-ordered).
  const agg = new Map<string, EditedFile>()

  for (const line of rawJsonl.split('\n')) {
    if (!line) continue
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const content = Array.isArray(obj?.message?.content) ? obj.message.content : null
    if (!content) continue
    const recTs = tsMs(obj.timestamp)

    if (obj.type === 'assistant') {
      for (const c of content) {
        if (c?.type !== 'tool_use' || !EDIT_TOOLS.has(c.name)) continue
        const fp = c.input?.file_path
        if (typeof fp !== 'string' || !fp || typeof c.id !== 'string') continue
        pending.set(c.id, { path: fp, ts: recTs })
      }
    } else if (obj.type === 'user') {
      for (const c of content) {
        if (c?.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue
        const p = pending.get(c.tool_use_id)
        if (!p) continue
        pending.delete(c.tool_use_id)
        if (c.is_error) continue // r1: errored edit didn't change the file
        const at = p.ts || recTs
        const a = agg.get(p.path)
        if (a) {
          a.count++
          if (at < a.firstAt) a.firstAt = at
          if (at > a.lastAt) a.lastAt = at
        } else {
          agg.set(p.path, { path: p.path, count: 1, firstAt: at, lastAt: at })
        }
      }
    }
  }
  return [...agg.values()]
}

/**
 * Upsert EDITED_IN edges (file → session) for one session's edited files. No-op
 * on a blank `sessionId` or empty `files`. Ensures both the session stub (dst)
 * and each file stub (src, kind='file', name=verbatim path so it joins
 * MENTIONS_FILE) so the edge never dangles.
 *
 * Two write modes for the two parse paths (see syncEditedIn):
 * - `'set'` (FULL reparse — first-sight / shrink / same-size change): `weight` is
 *   SET to the authoritative whole-file count. Correct because the whole file was
 *   parsed; a compaction that drops history resets the count to the new reality.
 * - `'add'` (GROW — only the appended tail was parsed): `weight += tail count`,
 *   `notedAt = max`. Adding the delta of an append-only growth yields the same
 *   total a full reparse would (the two modes are correctness-equivalent under
 *   append-only growth — that equivalence is what makes the tail-parse safe).
 *
 * `firstAt` is set on INSERT and excluded from BOTH conflict updates, so it stays
 * the first-ever edit (the s3 invariant — never bumped). In 'add' mode a tail
 * edit is always later than the stored firstAt, so the min-merge is a structural
 * no-op (firstAt can only be set correctly by the file's FIRST appearance).
 */
export function recordEditedIn(
  sessionId: string,
  files: EditedFile[],
  mode: 'set' | 'add' = 'set',
): void {
  const sid = (sessionId ?? '').trim()
  if (!sid || files.length === 0) return
  const conflict =
    mode === 'add'
      ? `DO UPDATE SET weight = weight + excluded.weight, notedAt = max(notedAt, excluded.notedAt)`
      : `DO UPDATE SET weight = excluded.weight, notedAt = excluded.notedAt`
  transaction(() => {
    ensureStubEntry(null, sid, sid, 'session', `session:${sid}`)
    for (const f of files) {
      const fid = fileEntryId(f.path)
      ensureStubEntry(null, fid, f.path, 'file', 'file')
      run(
        `INSERT INTO edges (src, dst, rel, weight, notedAt, firstAt) VALUES (?, ?, 'EDITED_IN', ?, ?, ?)
           ON CONFLICT(src, dst, rel) ${conflict}`,
        fid,
        sid,
        f.count,
        f.lastAt,
        f.firstAt,
      )
    }
  })
}

/**
 * Read a transcript's appended TAIL — the bytes in `[prevSize, EOF)` — for the
 * incremental grow path. Defends against a `prevSize` that fell MID-LINE (a sync
 * that statted during a partial append): if the byte before `prevSize` isn't a
 * newline, back up (bounded ≤1MB scan) to the start of that line so a record
 * split by the byte boundary is re-read whole, not dropped. A re-read line was
 * never counted before (it was incomplete at the prior boundary), so no
 * double-count. Returns '' when there is nothing new.
 */
async function readTail(file: string, prevSize: number): Promise<string> {
  const fh = await fs.open(file, 'r')
  try {
    const { size } = await fh.stat()
    let start = Math.min(Math.max(prevSize, 0), size)
    if (start > 0 && start < size) {
      const probe = Buffer.alloc(1)
      await fh.read(probe, 0, 1, start - 1)
      if (probe[0] !== 0x0a) {
        const window = Math.min(start, 1 << 20)
        const buf = Buffer.alloc(window)
        await fh.read(buf, 0, window, start - window)
        const nl = buf.lastIndexOf(0x0a)
        start = nl >= 0 ? start - window + nl + 1 : 0
      }
    }
    if (size <= start) return ''
    const out = Buffer.alloc(size - start)
    await fh.read(out, 0, size - start, start)
    return out.toString('utf-8')
  } finally {
    await fh.close()
  }
}

/**
 * Sync-integration: derive EDITED_IN for every CHANGED session transcript under
 * `<home>/.claude/projects/<proj>/*.jsonl`. r2 INCREMENTAL — a transcript whose
 * (mtime,size) is unchanged AND whose session is already a graph node is skipped
 * without opening it (the session-exists guard re-derives after a graph wipe,
 * since the manifest lives in the same DB and is dropped with it). Stats land in
 * the SHARED `manifestUpdates` (path-keyed; never collides with the memory
 * pre-pass's .md entries), persisted by the caller's single `writeSyncManifest`.
 *
 * A CHANGED transcript takes one of two paths (append-offset parsing — the active
 * transcript grows every turn, so a whole-reparse here was the ~1.16s/sync
 * saturation Fable measured on a 153MB live transcript):
 *   - GROW (size > stored prevSize): read ONLY the appended tail (readTail) and
 *     `recordEditedIn(..., 'add')`. The hot path — bounded by the append size.
 *   - FULL (first-sight, shrink/compaction, or same-size change): reparse whole +
 *     `'set'`. First-sight also backfills EDITED_IN from ALL existing transcripts
 *     on the first post-deploy sync (a one-time cost; incremental forever after).
 * The two modes are correctness-equivalent under append-only growth. KNOWN BOUND:
 * a single edit whose tool_use and tool_result straddle a cross-session mid-turn
 * sync boundary is transiently under-weighted (the tail sees the result without
 * its use); it self-heals on the next compaction (shrink → full SET), and D1
 * acted-on is edge-PRESENCE not weight, so corroboration is unaffected.
 * Best-effort per file — an unreadable/locked transcript is skipped, never thrown.
 */
export async function syncEditedIn(
  home: string,
  manifest: Map<string, FileStat>,
  manifestUpdates: Array<{ path: string; mtime: number; size: number }>,
): Promise<{ transcripts: number; sessions: number }> {
  let transcripts = 0
  let sessions = 0
  const projectsDir = path.join(home, '.claude', 'projects')
  let projects: Dirent[]
  try {
    projects = await fs.readdir(projectsDir, { withFileTypes: true })
  } catch {
    return { transcripts, sessions }
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const projDir = path.join(projectsDir, proj.name)
    let files: string[]
    try {
      files = (await fs.readdir(projDir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const fname of files) {
      const file = path.join(projDir, fname)
      const sid = fname.slice(0, -'.jsonl'.length)
      try {
        const st = await fs.stat(file)
        const mtime = Math.floor(st.mtimeMs)
        const size = st.size
        const sessionExists = !!get<{ id: string }>('SELECT id FROM entries WHERE id = ? LIMIT 1', sid)
        if (statUnchanged(file, mtime, size, manifest) && sessionExists) continue
        manifestUpdates.push({ path: file, mtime, size })
        const prev = manifest.get(file)
        let edited: EditedFile[]
        let mode: 'set' | 'add'
        if (prev !== undefined && sessionExists && size > prev.size) {
          // GROW: parse ONLY the appended tail and ADD — the hot path that avoids
          // re-reading a multi-hundred-MB active transcript every sync.
          edited = parseEditedFiles(await readTail(file, prev.size))
          mode = 'add'
        } else {
          // FULL reparse + SET: first-sight (incl. day-one backfill), shrink (a
          // /compact rewrite — SET reflects the new smaller content), or a
          // same-size in-place change.
          edited = parseEditedFiles(await fs.readFile(file, 'utf-8'))
          mode = 'set'
        }
        transcripts++
        if (edited.length > 0) {
          recordEditedIn(sid, edited, mode)
          sessions++
        }
      } catch {
        // unreadable / locked transcript — best-effort, skip
      }
    }
  }
  return { transcripts, sessions }
}
