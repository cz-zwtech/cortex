/**
 * The corpus, read from a V1 graph rather than from files.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — THE CORPUS WAS THE BINDING CONSTRAINT, NOT THE METHOD
 *
 * Reading authored memories off the local filesystem yields a few hundred entries
 * on one machine, and the sampled pairs from it are almost all dissimilar: a
 * handful at or above 0.8, typically none above 0.9. The near-duplicate floor IS 0.8. So the file
 * corpus cannot falsify a floor placed there — not because the sweep is wrong,
 * but because the region contains no data.
 *
 * The graph holds every memory this fleet has ever synced, including those
 * authored on machines whose files are not present here, often several times as
 * many entries and so an order of magnitude more pairs. That is the same corpus, seen without the
 * one-machine-filesystem restriction.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, AND DELIBERATELY LEGACY-AWARE
 *
 * This opens a V1 database as DATA. It is not a migration path and must not grow
 * into one: the columns it touches are the ones V1 happens to have, and V2's own
 * schema is unrelated. Opened read-only so a calibration run can never write to a
 * live graph.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCAFFOLDING IS EXCLUDED BY `kind`, NOT BY `authorship` — AND THAT IS NOT A
 * STYLE CHOICE
 *
 * The file reader excludes scaffolding by `authorship: auto-extracted`, because
 * in a memory *file* that marker appears on exactly the session and concept nodes
 * Cortex generates. Carrying the same filter here excludes the ENTIRE corpus:
 * in a V1 graph every memory, feedback and project entry (every authored row)
 * carries `authorship = 'auto-extracted'`,
 * because in the graph the field means "produced by the extraction pipeline",
 * which is how every memory gets there.
 *
 * **The same field name means different things in the two stores.** So the graph
 * reader filters on `kind`, which is the signal that actually distinguishes
 * authored prose from scaffolding here.
 *
 * This is one instance of a recurring failure class: a signal borrowed to answer
 * a question it was not derived for. Others are `content_hash` read as "the text
 * differs" (a large overcount) and `dim` read as "the model is the same" (a guard
 * that cannot fire).
 *
 * Byte-identical replicas are still collapsed, for the original reason: they would
 * manufacture perfect duplicates no estimator had to work for.
 */

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

import type { CorpusEntry, CorpusReport } from './corpus.js'

/**
 * Entry kinds that carry authored prose.
 *
 * `file`, `session`, `tool`, `pattern` and `symbol` are excluded: they are
 * scaffolding or code, not memories a human wrote, and the floors govern
 * judgements about facts.
 */
export const AUTHORED_KINDS = ['memory', 'feedback', 'project', 'reference', 'note', 'thread']

/**
 * Machine-generated entries that are stored as `kind = 'memory'`.
 *
 * `kind` is not sufficient on its own. Pre-compact checkpoints are written by
 * `bin/ckn-precompact.ts` with a long shared boilerplate header ("# Pre-compact
 * checkpoint / Auto-captured by Cortex before `/compact` summarised the
 * session…"), and they land as ordinary memories: **in a long-lived graph they
 * can be a tenth of the corpus.** Left in, they dominate the high-similarity bands with pairs whose
 * overlap is a template rather than a fact — the same contamination as the
 * session and concept nodes, arriving through a kind the filter trusts.
 *
 * Identified by the generator's own naming convention rather than by matching the
 * boilerplate text, so it does not drift when the template is reworded. Verified
 * as the only such class in V1: of the authored kinds, `precompact-` is the sole
 * name prefix that is machine-generated, and the auto-timestamped names are
 * exactly these.
 */
const GENERATED_NAME = /^precompact-/

export type GraphCorpusOptions = {
  kinds?: string[]
  /** Skip bodies shorter than this. Below the token floor nothing is judgeable. */
  minChars?: number
}

const idOf = (body: string): string => createHash('sha256').update(body).digest('hex').slice(0, 16)

export const readGraphCorpus = (
  dbPath: string,
  opts: GraphCorpusOptions = {},
): { corpus: CorpusEntry[]; report: CorpusReport } => {
  const kinds = opts.kinds ?? AUTHORED_KINDS
  const minChars = opts.minChars ?? 1

  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const placeholders = kinds.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT id, name, content, scope, source
           FROM entries
          WHERE kind IN (${placeholders})
            AND content IS NOT NULL AND content != ''
          ORDER BY id`,
      )
      .all(...kinds) as {
      id: string
      name: string | null
      content: string
      scope: string | null
      source: string | null
    }[]

    const seen = new Set<string>()
    const corpus: CorpusEntry[] = []
    let autoExtracted = 0
    let duplicates = 0

    for (const r of rows) {
      if (GENERATED_NAME.test(r.name ?? '')) {
        autoExtracted++
        continue
      }
      const body = r.content.trim()
      if (body.length < minChars) continue

      // Dedupe on BODY, never on a stored hash. V1's `content_hash` covers name
      // and description too, so hash inequality is not text inequality — reading
      // it as such overcounted distinct variants by ~75× on this very corpus.
      const key = idOf(body)
      if (seen.has(key)) {
        duplicates++
        continue
      }
      seen.add(key)

      corpus.push({
        id: key,
        source: r.source ?? `graph:${r.id}`,
        slug: r.name ?? '',
        scope: r.scope ?? 'user',
        body,
      })
    }

    return { corpus, report: { kept: corpus.length, autoExtracted, duplicates } }
  } finally {
    db.close()
  }
}
