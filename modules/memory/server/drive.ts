/**
 * The ingest driver — the thing whose absence made everything else inert.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE MODULE
 *
 * Before it, `memory.record` and `memory.sweep` were provided as capabilities
 * and CALLED BY NOTHING outside tests. There was no scheduler and no lifecycle
 * subscriber driving them. So on a clean install a human wrote a memory file and
 * nothing ever read it — the graph stayed empty permanently, and the module was
 * a library with no driver.
 *
 * Everything downstream inherited that: recall over an empty graph, and a dedupe
 * reflex that answered "no duplicates" on every call forever while reporting
 * success. A pipeline with no first stage is not a slow pipeline, it is a
 * disconnected one, and from the outside the two look identical.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A TIME BUDGET THAT REPORTS WHAT IT SKIPPED
 *
 * This runs inside a lifecycle hook with a budget measured in seconds, against a
 * directory that can hold hundreds of files. So it is bounded — and because a
 * bound here means MEMORIES WERE NOT INGESTED, it reports exactly which
 * directories it did not reach.
 *
 * "Swept 3 of 7 directories" and "swept everything, found nothing" must never be
 * the same output. A driver that silently ran out of time looks exactly like a
 * corpus with nothing new in it, and the consequence — a memory the human wrote
 * that never becomes recallable — is silent on every subsequent read.
 */

import fs from 'node:fs'
import path from 'node:path'

import { sweep, type SweepReport } from './sweep.js'
import type { IngestDeps } from './ingest.js'

export type DriveOptions = {
  /** Roots to look for `memory/` directories under. */
  roots: string[]
  machine: string
  sessionId?: string
  /** Wall-clock budget. Exceeding it stops the sweep and is REPORTED. */
  budgetMs?: number
  /** Injected so the budget is testable without waiting. */
  clock?: () => number
  maxDepth?: number
  /** Trust declared roots as memory dirs. See `memoryDirs`. */
  trustRoots?: boolean
  /** Passed to every sweep. See `consumeAllowed` in core/paths. */
  consume?: boolean
}

export type DriveReport = {
  /** Directories actually swept. */
  swept: string[]
  /**
   * Directories found but NOT swept because the budget ran out.
   *
   * Never empty-and-silent: if this has entries, memories exist that are not in
   * the graph, and any recall that follows is answering from an incomplete
   * corpus.
   */
  skipped: string[]
  files: number
  ingested: number
  declined: number
  dropped: number
  durationMs: number
  /** True when the budget stopped the run rather than the work running out. */
  budgetExhausted: boolean
}

export const DEFAULT_DRIVE_BUDGET_MS = 2_000

/**
 * Every `memory/` directory under the given roots.
 *
 * Bounded depth for the same reason the corpus reader bounds it: the projects
 * root holds one directory per encoded cwd, and an unbounded walk descends into
 * whatever else lives under them.
 */
export const memoryDirs = (
  roots: string[],
  maxDepth = 3,
  /**
   * Trust each root as a memory directory in its own right.
   *
   * Set when the roots were DECLARED (`CKN_MEMORY_DIRS`) rather than defaulted.
   * The `memory`-segment rule exists to pick memory directories out of a project
   * tree; applying it to a directory the user explicitly named is a silent trap —
   * the variable says these ARE memory dirs, and the sweep answers "no memory
   * directories found".
   */
  trustRoots = false,
): string[] => {
  const found: string[] = []
  const rootSet = new Set(roots.map((r) => path.resolve(r)))
  const walk = (dir: string, depth: number) => {
    if (depth < 0) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (path.basename(dir) === 'memory' || (trustRoots && rootSet.has(path.resolve(dir)))) {
      found.push(dir)
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth - 1)
    }
  }
  for (const r of roots) walk(r, maxDepth)
  return [...new Set(found)].sort()
}

/**
 * Scope for a memory directory, from the layout that already encodes it.
 *
 * `~/.claude/memory` → user; `~/.claude/projects/<encoded>/memory` → <encoded>.
 */
export const scopeForDir = (dir: string): string => {
  const segs = path.resolve(dir).split(path.sep)
  const i = segs.lastIndexOf('projects')
  return i >= 0 && segs[i + 1] ? segs[i + 1]! : 'user'
}

/**
 * Sweep every memory directory, within a budget, and say what was missed.
 *
 * The budget is checked BEFORE each directory rather than mid-file: a partly
 * swept directory would leave a file's blocks split between ingested and not,
 * and the consume step rewrites whole files. Stopping on a directory boundary is
 * what keeps a bounded run from corrupting the inbox.
 */
export const drive = (opts: DriveOptions, deps: IngestDeps): DriveReport => {
  const clock = opts.clock ?? Date.now
  const budget = opts.budgetMs ?? DEFAULT_DRIVE_BUDGET_MS
  const started = clock()

  const dirs = memoryDirs(opts.roots, opts.maxDepth, opts.trustRoots)
  const report: DriveReport = {
    swept: [],
    skipped: [],
    files: 0,
    ingested: 0,
    declined: 0,
    dropped: 0,
    durationMs: 0,
    budgetExhausted: false,
  }

  for (const dir of dirs) {
    if (clock() - started >= budget) {
      report.budgetExhausted = true
      report.skipped.push(dir)
      continue
    }

    let out: SweepReport
    try {
      out = sweep(
        {
          memoryDir: dir,
          scope: scopeForDir(dir),
          machine: opts.machine,
          sessionId: opts.sessionId,
          now: deps.now,
          consume: opts.consume,
        },
        deps,
      )
    } catch {
      // One unreadable directory must not stop the others — but it is a SKIP,
      // not a success, so it lands in the reported list.
      report.skipped.push(dir)
      continue
    }

    report.swept.push(dir)
    report.files += out.files
    report.ingested += out.ingested
    report.declined += out.declined
    report.dropped += out.dropped
  }

  report.durationMs = clock() - started
  return report
}

/** One line for a log. Says what was NOT done, not only what was. */
export const describeDrive = (r: DriveReport): string => {
  const base = `ingest: ${r.ingested} memor${r.ingested === 1 ? 'y' : 'ies'} from ${r.files} file(s) across ${r.swept.length} dir(s) in ${r.durationMs}ms`
  const declined = r.declined ? `, ${r.declined} quarantined` : ''
  const skipped = r.skipped.length
    ? ` — ${r.skipped.length} DIRECTORY(IES) NOT SWEPT${r.budgetExhausted ? ' (budget exhausted)' : ''}: ${r.skipped.join(', ')}`
    : ''
  return base + declined + skipped
}
