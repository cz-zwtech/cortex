/**
 * Keep MEMORY.md under the harness auto-memory load cap.
 *
 * Claude Code's native auto-memory loads only the FIRST ~200 lines / ~25KB of
 * MEMORY.md each session — anything past that is silently truncated, so a growing
 * index quietly drops real pointers from every session. This module plans a
 * non-destructive prune: PIN standing-rule / user pointers, ARCHIVE completed
 * (SHIPPED/DONE/MERGED/superseded) non-pinned pointers into a sibling
 * MEMORY-archive.md (never auto-loaded; the underlying memories stay in the graph),
 * and FLAG when the un-archivable remainder still exceeds the cap so the caller can
 * warn loudly. Pure + deterministic; the I/O (read/write/append) lives in the sync
 * step that calls this. Targets a margin under the hard cap.
 *
 * SAFE v1: archives ONLY by explicit completion markers — it never guesses "oldest"
 * (the index isn't reliably chronological), so it can't drop an active pointer.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Default prune target — a margin under the documented ~200-line / 25KB hard cap.
 *  The byte margin sits at 24KB (not lower): a HEALTHY trimmed index with nothing
 *  left to archive can legitimately run ~23KB of pinned content, and a tighter
 *  margin would loud-warn every sync with no way to self-resolve. 24KB still leaves
 *  headroom before the 25KB hard truncation. */
export const DEFAULT_CAP_BYTES = 24_000
export const DEFAULT_CAP_LINES = 190

const POINTER_RE = /^- \[/
const COMPLETION_RE = /\b(SHIPPED|DONE|MERGED|SUPERSEDED|CLOSED|RETIRED)\b/i

export interface EntryClass {
  path: string | null
  pinned: boolean
  archivable: boolean
}

/**
 * Classify one index pointer line. `pinned` = a standing rule / user preference
 * (path basename starts feedback-/user-, or an explicit PINNED marker) — never
 * archived. `archivable` = carries a completion marker in its hook text.
 */
export const classifyEntry = (line: string): EntryClass => {
  const m = line.match(/\]\(([^)]+)\)/)
  const path = m?.[1] ?? null
  const base = path ? (path.split('/').pop() ?? '') : ''
  const pinned = /^(feedback-|user-)/.test(base) || /\bPINNED\b/.test(line)
  const archivable = COMPLETION_RE.test(line)
  return { path, pinned, archivable }
}

export interface PrunePlan {
  header: string
  kept: string[]
  archived: string[]
  overCap: boolean
  keptLines: number
  keptBytes: number
}

const buildText = (header: string, lines: string[]): string => `${header}${lines.join('\n')}\n`

/**
 * Plan a prune of a MEMORY.md index. Returns the preserved header, the kept
 * pointer lines, the lines to move to MEMORY-archive.md, and `overCap` (true when
 * even after archiving completed non-pinned pointers the index still exceeds the
 * cap — the caller should warn loudly rather than drop active/pinned content).
 * A no-op (kept = all, archived = []) when already under the cap.
 */
export const planIndexPrune = (
  content: string,
  opts?: { capBytes?: number; capLines?: number },
): PrunePlan => {
  const capBytes = opts?.capBytes ?? DEFAULT_CAP_BYTES
  const capLines = opts?.capLines ?? DEFAULT_CAP_LINES
  const all = content.split('\n')
  const firstPtr = all.findIndex((l) => POINTER_RE.test(l))
  const header = firstPtr <= 0 ? '' : all.slice(0, firstPtr).join('\n') + '\n'
  const entries = firstPtr < 0 ? [] : all.filter((l) => POINTER_RE.test(l))

  const measure = (lines: string[]): { lines: number; bytes: number } => {
    const text = buildText(header, lines)
    return { lines: text.split('\n').length, bytes: Buffer.byteLength(text, 'utf8') }
  }
  const over = (lines: string[]): boolean => {
    const mm = measure(lines)
    return mm.bytes > capBytes || mm.lines > capLines
  }

  if (!over(entries)) {
    const mm = measure(entries)
    return { header, kept: entries, archived: [], overCap: false, keptLines: mm.lines, keptBytes: mm.bytes }
  }

  const kept: string[] = []
  const archived: string[] = []
  for (const e of entries) {
    const c = classifyEntry(e)
    if (c.archivable && !c.pinned) archived.push(e)
    else kept.push(e)
  }
  const mm = measure(kept)
  return { header, kept, archived, overCap: over(kept), keptLines: mm.lines, keptBytes: mm.bytes }
}

export interface PruneResult {
  archivedCount: number
  keptLines: number
  keptBytes: number
  overCap: boolean
  archivePath: string
}

const ARCHIVE_HEADER =
  '# Cortex memory archive — completed/superseded index pointers.\n' +
  '# NOT auto-loaded by the harness (only MEMORY.md is); the underlying memories stay in the graph + recall.\n\n'

/**
 * Apply a prune to one MEMORY.md on disk: move completed-non-pinned pointers into a
 * sibling MEMORY-archive.md (append, deduped) and rewrite MEMORY.md with the kept
 * set. No-op (and no write) when already under cap or when the file is absent.
 * Returns a summary (or null if there's no MEMORY.md to prune).
 */
export const applyIndexPrune = async (
  mdPath: string,
  opts?: { capBytes?: number; capLines?: number },
): Promise<PruneResult | null> => {
  let content: string
  try {
    content = await fs.readFile(mdPath, 'utf-8')
  } catch {
    return null // no index here
  }
  const plan = planIndexPrune(content, opts)
  if (plan.archived.length === 0) {
    return { archivedCount: 0, keptLines: plan.keptLines, keptBytes: plan.keptBytes, overCap: plan.overCap, archivePath: '' }
  }
  const archivePath = path.join(path.dirname(mdPath), 'MEMORY-archive.md')
  let existing = ''
  try {
    existing = await fs.readFile(archivePath, 'utf-8')
  } catch {
    // first archive
  }
  const have = new Set(existing.split('\n'))
  const toAppend = plan.archived.filter((l) => !have.has(l))
  if (toAppend.length > 0) {
    const base = existing ? (existing.endsWith('\n') ? existing : existing + '\n') : ARCHIVE_HEADER
    await fs.writeFile(archivePath, base + toAppend.join('\n') + '\n', 'utf-8')
  }
  await fs.writeFile(mdPath, plan.header + plan.kept.join('\n') + '\n', 'utf-8')
  return {
    archivedCount: plan.archived.length,
    keptLines: plan.keptLines,
    keptBytes: plan.keptBytes,
    overCap: plan.overCap,
    archivePath,
  }
}

/**
 * Enumerate every MEMORY.md index under a Cortex home: the user index
 * (~/.claude/memory/MEMORY.md) plus each project index
 * (~/.claude/projects/<encoded>/memory/MEMORY.md). Non-existent paths are returned
 * too — applyIndexPrune skips them — so the caller need not pre-check.
 */
export const memoryIndexPaths = async (home: string): Promise<string[]> => {
  const out: string[] = [path.join(home, '.claude', 'memory', 'MEMORY.md')]
  const projectsDir = path.join(home, '.claude', 'projects')
  try {
    for (const d of await fs.readdir(projectsDir, { withFileTypes: true })) {
      if (d.isDirectory()) out.push(path.join(projectsDir, d.name, 'memory', 'MEMORY.md'))
    }
  } catch {
    // no projects dir
  }
  return out
}
