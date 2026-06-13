#!/usr/bin/env tsx
/**
 * ABOUT tier-1 real-data smoke (Item-2 slice 5 — Fable's required end-to-end).
 *
 * The one failure mode that ships a quietly-worthless bridge is a path-shape
 * mismatch between stored `mentions_files` (verbatim, heterogeneous) and the
 * repo-relative edit target. Hand-written fixtures encode the author's ASSUMED
 * shape, so only REAL stored data can prove the join works. This runs the
 * ACTUAL join over the REAL graph for a known repo-relative file and asserts
 * >=1 match — and prints the matched stored shapes so the cross-machine /
 * absolute unification is visible.
 *
 * API-first: hits the live server's /api/graph/recall/for-file (the production
 * path, once the server carries the route). Falls back to a READ-ONLY direct
 * graph join (using the real fileMentionMatches predicate) when the route isn't
 * live yet or the server is down — never opens a writable handle, so it is safe
 * to run while the server owns the single writer.
 *
 * Usage: tsx bin/ckn-file-knowledge-smoke.ts [repo-relative-file]
 *        (default target: bin/ckn-sync.ts — present under multiple machine roots)
 */
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { fileMentionMatches } from '../server/graph/fileMatch.js'

const file = process.argv[2] || 'bin/ckn-sync.ts'
const SERVER = 'http://localhost:3001'

const viaApi = async (): Promise<{ id: string; name?: string }[] | null> => {
  try {
    const res = await fetch(`${SERVER}/api/graph/recall/for-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file, limit: 5 }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return ((await res.json()) as { hits?: { id: string; name?: string }[] }).hits ?? []
  } catch {
    return null
  }
}

const viaReadOnlyJoin = (): { memId: string; storedPath: string }[] => {
  const dbPath =
    process.env.CKN_GRAPH_DB_PATH || path.join(os.homedir(), '.config', 'ckn', 'graph.sqlite')
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare(
        // Mirror recallForFile: exclude session-sourced edges (parity + cost).
        `SELECT e.src AS memId, f.name AS storedPath
           FROM edges e
           JOIN entries f ON f.id = e.dst
           JOIN entries s ON s.id = e.src
          WHERE e.rel = 'MENTIONS_FILE' AND f.kind = 'file' AND s.kind <> 'session'`,
      )
      .all() as { memId: string; storedPath: string }[]
    return rows.filter((r) => r.storedPath && fileMentionMatches(r.storedPath, file))
  } finally {
    db.close()
  }
}

const main = async () => {
  const api = await viaApi()
  if (api) {
    console.log(`file-knowledge smoke · ${file} · via LIVE server API`)
    console.log(`matches: ${api.length}`)
    for (const h of api.slice(0, 5)) console.log(`  - ${h.id}  ${h.name ?? ''}`)
    if (api.length === 0) {
      console.error(`FAIL: 0 matches via API for ${file}`)
      process.exit(1)
    }
    console.log('PASS (API): the live recallForFile join surfaced >=1 real memory')
    return
  }

  const matched = viaReadOnlyJoin()
  const mems = new Set(matched.map((m) => m.memId))
  const shapes = new Set(matched.map((m) => m.storedPath))
  console.log(`file-knowledge smoke · ${file} · via read-only graph join (API unreachable/errored — fell back to direct DB)`)
  console.log(`matched memories: ${mems.size}; distinct stored shapes: ${shapes.size}`)
  for (const s of [...shapes].slice(0, 8)) console.log(`  shape: ${s}`)
  if (mems.size === 0) {
    console.error(`FAIL: 0 real memories mention ${file} — path-shape mismatch or none exist`)
    process.exit(1)
  }
  console.log(
    'PASS (read-only): the real fileMentionMatches unified the real stored shapes under one repo-relative target',
  )
}

main().catch((e) => {
  console.error('smoke error:', e?.message ?? e)
  process.exit(1)
})
