/**
 * The scratchpad sweep — the thing that actually runs the pipeline.
 *
 * Everything else in this module was proven IN PROCESS. This is where the parts
 * become a system with a directory on one end and a graph on the other, which is
 * the same in-process-versus-real distinction the harness UAT applies one level
 * up: a library that passes its own tests has not yet been run by anything.
 *
 *   for each .md in the memory dir
 *     split into blocks (a file may hold many memories)
 *       ingest each  → scan · append · reconcile · write · receipt · ticket
 *     annotate declines back into the file
 *     consume, authorised by the merged ticket
 *
 * ONE TICKET PER FILE, merged from the per-block ingests. Consume rewrites a
 * whole file, so calling it per block would rewrite the file N times and race
 * itself — and each rewrite would be authorised for one hash while dropping
 * nothing else, which happens to be safe but is safe by accident.
 */

import fs from 'node:fs'
import path from 'node:path'

import { annotateDeclines, consume, splitScratchpad, stubsIn, type DeclineNotice } from './consume.js'
import { ingest, type IngestDeps, type IngestInput, type Receipt } from './ingest.js'
import { renderMemoryIndex } from './memoryIndex.js'
import { stubTarget, withAppended } from './stubAppend.js'
import { indexSubjects } from './subjects.js'

export type SweepReport = {
  files: number
  ingested: number
  declined: number
  dropped: number
  receipts: Receipt[]
  /** Quarantine entries cleared because their file in this dir is gone (said once, by the caller). */
  cleared: string[]
  /** Files whose text was already a memory, and which one. */
  folded: { source: string; into: string }[]
  /** Text added below a stub, applied as an update of the memory that file stands for. */
  appendedTo: { source: string; into: string }[]
  /** Files with text below a stub that no single memory owns: held in place with a note. */
  heldAppends: string[]
}

/** A block that opens with frontmatter is a memory in its own right, wherever it sits. */
const FRONTMATTER = /^\s*---\s*\n/

/** Files the sweep must never treat as an inbox. */
const NOT_AN_INBOX = new Set(['MEMORY.md', 'MEMORY-archive.md'])

export type SweepOptions = {
  memoryDir: string
  scope: string
  machine: string
  sessionId?: string
  now?: () => number
  /** Rewrite files after ingest (stub, decline notes). False leaves every file as it was. */
  consume?: boolean
}

export const sweep = (opts: SweepOptions, deps: IngestDeps): SweepReport => {
  const now = opts.now ?? Date.now
  const report: SweepReport = { files: 0, ingested: 0, declined: 0, dropped: 0, receipts: [], cleared: [], folded: [], appendedTo: [], heldAppends: [] }

  // A held memory whose file is gone (deleted by hand, 20 Oct) has nothing left to fix or release, so it
  // leaves the queue; otherwise status reports it held forever. Only this dir's entries, only a missing file.
  for (const q of deps.store.quarantined()) {
    if (path.dirname(q.source) === path.resolve(opts.memoryDir) && !fs.existsSync(q.source) && deps.store.clearDecline(q.hash)) {
      report.cleared.push(q.source)
    }
  }

  let entries: string[]
  try {
    entries = fs.readdirSync(opts.memoryDir)
  } catch {
    return report // no memory dir yet is the normal state of a fresh install
  }

  for (const name of entries) {
    if (!name.endsWith('.md') || NOT_AN_INBOX.has(name)) continue

    const source = path.join(opts.memoryDir, name)
    let text: string
    try {
      text = fs.readFileSync(source, 'utf-8')
    } catch {
      continue
    }

    const blocks = splitScratchpad(text)
    if (!blocks.length) continue
    report.files++

    const hashes: string[] = []
    const notices: DeclineNotice[] = []
    const stubbed = stubsIn(text).length > 0

    for (const b of blocks) {
      let input: IngestInput = {
        content: b.raw,
        body: b.body,
        slug: slugOf(b.raw) || path.basename(name, '.md'),
        scope: opts.scope,
        source,
        machine: opts.machine,
        authoredAt: authoredAtOf(source, now),
        sessionId: opts.sessionId,
      }
      // Text without frontmatter below a stub updates the memory the stub stands for (stubAppend.ts).
      if (stubbed && !FRONTMATTER.test(b.raw)) {
        const target = stubTarget(deps.store, deps.journal, source)
        if (!target) {
          report.declined++
          report.heldAppends.push(source)
          notices.push({ hash: b.hash, reason: 'appended-to-stub', findings: [] })
          continue
        }
        const merged = splitScratchpad(withAppended(target.raw, b.body))[0]!
        input = { ...input, content: merged.raw, body: merged.body, slug: target.memory.name, declaredId: target.memory.id }
        report.appendedTo.push({ source, into: target.memory.id })
      }
      const appended = input.declaredId !== undefined
      const result = ingest(input, deps)

      if (result.status === 'quarantined') {
        report.declined++
        notices.push({ hash: b.hash, findings: result.findings })
        continue
      }

      // A fold adds nothing new: the text was already a memory. Said as such, never as "ingested",
      // so a file that seems to vanish into another record is visible (node-b, 20 Oct).
      if (result.receipt.action === 'fold') report.folded.push({ source, into: result.receipt.id })
      else report.ingested++
      report.receipts.push(result.receipt)
      hashes.push(...result.ticket.hashes)
      // The appended block reached the journal inside the merged memory, so it may be consumed by its own hash.
      if (appended) hashes.push(b.hash)
    }

    // CONSUME FIRST, ANNOTATE LAST — and an earlier revision had this backwards
    // with a plausible-sounding reason attached.
    //
    // `splitScratchpad` strips decline markers before dividing the file, because
    // a record ABOUT the content must not participate in deciding what the
    // content is. Consume rebuilds the file from those stripped blocks, so
    // annotating first meant consume immediately erased every notice it had just
    // written. The writer saw nothing, and the quarantine went back to depending
    // on somebody checking `status`.
    //
    // Whichever step writes last owns the file. That is annotate.
    if (opts.consume === false) continue
    if (hashes.length) {
      const out = consume({ source, hashes, mintedAt: now() }, { stub: true })
      report.dropped += out.dropped
    }

    annotateDeclines(source, notices)
  }

  // MEMORY.md is rendered, never ingested, and only where files may be rewritten.
  if (opts.consume !== false) renderMemoryIndex(opts.memoryDir)
  // People and titles the memories state. Bounded: a sweep also runs inside hooks, and the
  // first pass over a large store is the host's to do at start.
  indexSubjects(deps.store, { limit: 500, deadline: Date.now() + 300 })

  return report
}

const frontmatterField = (raw: string, field: string): string => {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return ''
  const line = (m[1] ?? '').split('\n').find((l) => l.trim().startsWith(`${field}:`))
  return line ? line.slice(line.indexOf(':') + 1).trim().replace(/^(['"])(.*)\1$/, '$2') : ''
}

/** The frontmatter `name:`, which is the slug the ladder reconciles on. */
export const slugOf = (raw: string): string => frontmatterField(raw, 'name')

/**
 * When the human wrote it, best-effort from mtime.
 *
 * `authored_at` and `ingested_at` are genuinely different clocks and recall
 * ranks recency on the first, so defaulting both to now() would quietly collapse
 * the distinction the schema exists to keep. mtime is wrong for a file edited
 * after writing, which is why it is documented as best-effort rather than
 * presented as the authored time.
 */
const authoredAtOf = (file: string, now: () => number): number => {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return now()
  }
}
