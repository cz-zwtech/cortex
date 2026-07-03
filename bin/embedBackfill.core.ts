/**
 * Pure core for ckn-embed-backfill (#139 C). Kept separate from the CLI so the
 * arg parsing and the skip/force/counting logic are unit-testable without a
 * graph DB or the embedding model. The CLI is a thin wrapper that supplies the
 * real SQL rows, embeddedIdSet, embedText, and putEmbedding.
 */

export interface BackfillArgs {
  force: boolean
  limit: number | null
  offset: number
}

/** Parse --force / --limit N / --offset N. Unknown flags are ignored (the CLI
 *  handles --help before calling this). */
export const parseBackfillArgs = (argv: string[]): BackfillArgs => {
  const out: BackfillArgs = { force: false, limit: null, offset: 0 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--force') out.force = true
    else if (a === '--limit') out.limit = Number(argv[++i] ?? '')
    else if (a === '--offset') out.offset = Number(argv[++i] ?? '')
  }
  return out
}

/** The documented skip: re-embed a row only when forced or it has no vector
 *  yet. Without --force an already-embedded row is skipped (idempotent). */
export const shouldEmbedRow = (hasVector: boolean, force: boolean): boolean =>
  force || !hasVector

export interface BackfillRow {
  id: string
  name: string
  description: string
  content: string
}

export interface BackfillDeps {
  embed: (text: string) => Promise<Float32Array | null>
  put: (id: string, vec: Float32Array) => Promise<void>
  textFor: (row: BackfillRow) => string
  /** Optional progress hook, called after each successful embed. Cosmetic. */
  onProgress?: (embedded: number, total: number) => void
}

export interface BackfillResult {
  embedded: number
  skipped: number
  failed: number
}

/**
 * Walk the selected rows: skip the ones that already have a vector (unless
 * force), embed the rest, and count outcomes. A null vector (embeddings off /
 * mailbox shed) or a thrown error counts as failed and the loop continues —
 * one bad row never aborts the backfill.
 */
export const runBackfill = async (
  rows: BackfillRow[],
  existingIds: Set<string>,
  force: boolean,
  deps: BackfillDeps,
): Promise<BackfillResult> => {
  let embedded = 0
  let skipped = 0
  let failed = 0
  for (const row of rows) {
    if (!shouldEmbedRow(existingIds.has(row.id), force)) {
      skipped++
      continue
    }
    let vec: Float32Array | null = null
    try {
      vec = await deps.embed(deps.textFor(row))
    } catch {
      failed++
      continue
    }
    if (!vec) {
      failed++
      continue
    }
    await deps.put(row.id, vec)
    embedded++
    deps.onProgress?.(embedded, rows.length)
  }
  return { embedded, skipped, failed }
}
