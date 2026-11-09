/**
 * The calibration corpus — OUR memories, not a benchmark's.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT LongMemEval / LoCoMo
 *
 * Task 138 as specified names those two, and they are the right instruments for
 * the RECALL weights (does the right memory come back for a query). They are the
 * wrong instrument for every threshold currently shipped, all five of which
 * answer a different question: ARE THESE TWO MEMORIES THE SAME FACT.
 *
 * And the corpus matters as much as the metric. A floor tuned on benchmark chat
 * transcripts is someone else's afternoon with fresher numbers — the exact
 * failure the re-derive ruling exists to prevent. It is the same shape as
 * reuse-the-detector-re-derive-the-exclusions in the secret scanner: the
 * mechanism travels between corpora, the tuning does not. Our memories are
 * frontmatter-headed technical prose written by these sessions, with real
 * re-saves in them, and that distribution is what the floors have to survive.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS HONESTLY NOT
 *
 * Labels come from human judgement over a fixed sample. That is still taste —
 * but taste applied ONCE, to a stored fixture, auditable and re-runnable by
 * anyone who disagrees, rather than taste compiled invisibly into a constant.
 * It converts an unexaminable number into an examinable dataset. It does not
 * make the number objective, and the doc must not claim it does.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { splitScratchpad } from '../server/consume.js'
import { slugOf } from '../server/sweep.js'

export type CorpusEntry = {
  /** Stable across runs: the fixture references these, files move. */
  id: string
  source: string
  slug: string
  scope: string
  /** Body only — frontmatter is metadata and would inflate every similarity. */
  body: string
}

export type CorpusReport = {
  kept: number
  /** Excluded as machine-generated scaffolding, by declared authorship. */
  autoExtracted: number
  /** Collapsed as byte-identical replication. */
  duplicates: number
}

/**
 * MACHINE-GENERATED NODES ARE EXCLUDED, AND LEAVING THEM IN WOULD HAVE SET THE
 * FLOOR BY BOILERPLATE.
 *
 * The memory directories contain more than authored memories. Cortex writes
 * scaffolding nodes there too — one per session ("Session entry — see N turns of
 * activity in the linked transcript…") and one per tool ("Auto-generated concept
 * node for the `X` tool…"). They are template instances differing by a single
 * token.
 *
 * Measured consequence: with them included, the 0.8–0.95 similarity bands filled
 * almost entirely with pairs of these. They ARE different from each other — two
 * distinct sessions, two distinct tools — so labelling them honestly as
 * `different` would have forced the near-duplicate floor UP to avoid merging
 * them. The floor would then have been determined by the shape of a template
 * rather than by any judgement about facts, and it would have looked derived.
 *
 * The filter keys on the corpus's OWN declaration — `authorship: auto-extracted`
 * in frontmatter — rather than on a text heuristic, so it cannot drift as
 * templates change.
 *
 * LIMITATION, STATED: the recall collapse does rank these at query time, so a
 * collapse threshold calibrated here is calibrated on authored memories only.
 * The write-time reflex is unaffected — it fires on model tool-writes, and these
 * are written by Cortex's own sync, which never passes through the harness.
 */
const AUTO_AUTHORSHIP = /^\s*authorship:\s*auto-extracted\s*$/im

/** Files that are indexes or archives, never memories. */
const NOT_A_MEMORY = new Set(['MEMORY.md', 'MEMORY-archive.md'])

const idOf = (body: string): string => createHash('sha256').update(body).digest('hex').slice(0, 16)

/**
 * Walk a root and collect every memory file under a `memory/` segment.
 *
 * Bounded depth because these roots contain project trees: `~/.claude/projects`
 * holds one directory per encoded cwd, each with a `memory/` inside, and an
 * unbounded walk there would descend into whatever else lives under them.
 */
const walk = (dir: string, depth: number, out: string[]): void => {
  if (depth < 0) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, depth - 1, out)
    else if (e.isFile() && e.name.endsWith('.md') && !NOT_A_MEMORY.has(e.name)) {
      if (path.dirname(full).split(path.sep).includes('memory')) out.push(full)
    }
  }
}

const scopeOf = (file: string): string => {
  const segs = file.split(path.sep)
  const i = segs.lastIndexOf('projects')
  return i >= 0 && segs[i + 1] ? segs[i + 1]! : 'user'
}

/**
 * Read every memory in the given roots.
 *
 * Deduplicated by body hash: the same memory legitimately exists in more than
 * one place on this fleet (user-wide and project-scoped copies, and the
 * cross-machine sync), and counting it twice would manufacture perfect
 * duplicates that no estimator had to work for — inflating every metric with
 * pairs the system never has to judge.
 */
export const readCorpus = (
  roots: string[],
  opts: { maxDepth?: number; includeAutoExtracted?: boolean } = {},
): CorpusEntry[] => read(roots, opts).corpus

/** Same, with the counts of what was left out. Nothing reduces scope silently. */
export const read = (
  roots: string[],
  opts: { maxDepth?: number; includeAutoExtracted?: boolean } = {},
): { corpus: CorpusEntry[]; report: CorpusReport } => {
  const files: string[] = []
  for (const r of roots) walk(r, opts.maxDepth ?? 3, files)

  const seen = new Set<string>()
  const out: CorpusEntry[] = []
  let autoExtracted = 0
  let duplicates = 0

  for (const file of files.sort()) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }

    if (!opts.includeAutoExtracted && AUTO_AUTHORSHIP.test(frontmatterOf(text))) {
      autoExtracted++
      continue
    }

    const blocks = splitScratchpad(text)
    const units = blocks.length ? blocks : [{ raw: text, body: text, hash: '' }]

    for (const u of units) {
      const body = u.body.trim()
      if (!body) continue
      const id = idOf(body)
      if (seen.has(id)) {
        duplicates++
        continue
      }
      seen.add(id)
      out.push({ id, source: file, slug: slugOf(u.raw), scope: scopeOf(file), body })
    }
  }

  return { corpus: out, report: { kept: out.length, autoExtracted, duplicates } }
}

const frontmatterOf = (text: string): string => {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/)
  return m?.[1] ?? ''
}
