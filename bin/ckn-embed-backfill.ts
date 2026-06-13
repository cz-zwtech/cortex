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
export {}

interface Args {
  force: boolean
  limit: number | null
}

const parseArgs = (): Args => {
  const argv = process.argv.slice(2)
  const out: Args = { force: false, limit: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--force') out.force = true
    else if (a === '--limit') out.limit = Number(argv[++i] ?? '')
    else if (a === '--help' || a === '-h') {
      console.log('usage: ckn-embed-backfill [--force] [--limit N]')
      process.exit(0)
    }
  }
  return out
}

const main = async () => {
  const args = parseArgs()
  const { getEmbeddingMode, embedText, embeddingTextForEntry } = await import('../server/embeddings.js')
  if (getEmbeddingMode() === 'off') {
    console.log('[ckn embed-backfill] CKN_EMBEDDINGS=off — nothing to do')
    return
  }
  // SQLite + WAL: this read coexists with the server's writer (no single-
  // writer lock to collide on), so there's no isServerUp() bail anymore —
  // run it server-up or server-down.
  const { all } = await import('../server/graph/db.js')
  const { putEmbedding } = await import('../server/embeddingStore.js')
  const { embeddingCount } = await import('../server/embeddingStore.js')

  const before = await embeddingCount()
  console.log(`[ckn embed-backfill] starting — ${before} embeddings in store`)

  // Pull every Entry — limit + skip stub-only entries (kind=file/tool
  // are traversal hubs, not memories worth embedding).
  const limit = args.limit && args.limit > 0 ? args.limit : 100_000
  type Row = { id: string; name: string; description: string; content: string }
  const rows = all<Row>(
    `SELECT id AS id, name AS name, description AS description, content AS content ` +
      `FROM entries WHERE kind <> 'file' AND kind <> 'tool' ` +
      `LIMIT ?`,
    limit,
  )

  let embedded = 0
  let skipped = 0
  let failed = 0
  const t0 = Date.now()
  for (const row of rows) {
    try {
      const text = embeddingTextForEntry(row)
      const vec = await embedText(text)
      if (!vec) {
        failed++
        continue
      }
      await putEmbedding(row.id, vec)
      embedded++
      if (embedded % 25 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
        console.log(`  ${embedded}/${rows.length} embedded (${elapsed}s elapsed)`)
      }
    } catch (e: any) {
      console.warn(`  skipped ${row.id}: ${e?.message ?? e}`)
      failed++
    }
  }

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
