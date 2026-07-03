#!/usr/bin/env tsx
/**
 * ckn-embed-backfill — re-embed every Entry in the graph.
 *
 * Useful when:
 *   - You toggle CKN_EMBEDDINGS=local for the first time on a graph
 *     that already has entries (none of them have embeddings yet).
 *   - You changed the embedding model and want to refresh.
 *   - The sidecar gets corrupted or deleted.
 *
 * Idempotent. Skips entries that already have an embedding unless
 * --force is passed. Reads the SQLite graph directly via the db.ts
 * helpers. SQLite + WAL allows concurrent readers alongside the server's
 * writer, so this no longer collides on a DB lock — it can run whether or
 * not the Cortex server is up (the old isServerUp() bail is gone).
 */
import { parseBackfillArgs, runBackfill } from './embedBackfill.core.js'

const main = async () => {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: ckn-embed-backfill [--force] [--limit N] [--offset N]')
    return
  }
  const args = parseBackfillArgs(argv)
  const { getEmbeddingMode, embedText, embeddingTextForEntry } = await import('../server/embeddings.js')
  if (getEmbeddingMode() === 'off') {
    console.log('[ckn embed-backfill] CKN_EMBEDDINGS=off — nothing to do')
    return
  }
  // SQLite + WAL: this read coexists with the server's writer (no single-
  // writer lock to collide on), so there's no isServerUp() bail anymore —
  // run it server-up or server-down.
  const { all } = await import('../server/graph/db.js')
  const { putEmbedding, embeddingCount, embeddedIdSet } = await import('../server/embeddingStore.js')

  const before = await embeddingCount()
  console.log(`[ckn embed-backfill] starting — ${before} embeddings in store`)

  // Pull candidate Entries — skip stub-only entries (kind=file/tool are
  // traversal hubs, not memories worth embedding). ORDER BY id gives --offset a
  // stable page so a huge corpus can be backfilled in resumable chunks.
  const limit = args.limit && args.limit > 0 ? args.limit : 100_000
  type Row = { id: string; name: string; description: string; content: string }
  const rows = all<Row>(
    `SELECT id AS id, name AS name, description AS description, content AS content ` +
      `FROM entries WHERE kind <> 'file' AND kind <> 'tool' ` +
      `ORDER BY id LIMIT ? OFFSET ?`,
    limit,
    args.offset,
  )

  // The documented skip: without --force, entries that already have a vector
  // are skipped (idempotent); --force re-embeds them.
  const existing = await embeddedIdSet()
  const t0 = Date.now()
  const { embedded, skipped, failed } = await runBackfill(rows, existing, args.force, {
    embed: embedText,
    put: putEmbedding,
    textFor: embeddingTextForEntry,
    onProgress: (n, total) => {
      if (n % 25 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
        console.log(`  ${n}/${total} embedded (${elapsed}s elapsed)`)
      }
    },
  })

  const after = await embeddingCount()
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(
    `[ckn embed-backfill] done — embedded ${embedded}, skipped ${skipped}, failed ${failed} in ${elapsed}s`,
  )
  console.log(`[ckn embed-backfill] store: ${before} → ${after} embeddings`)
}

main().catch((e) => {
  console.error('[ckn embed-backfill] fatal:', e?.message ?? e)
  process.exit(1)
})
