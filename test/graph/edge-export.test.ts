#!/usr/bin/env tsx
/**
 * #126 — graph edge export. getAllForGraph() previously emitted ONLY LINKS_TO
 * edges, so ~83% of memory nodes rendered isolated. The fix exports EVERY edge
 * whose BOTH endpoints exist in the entries node-set, carrying its `rel` — a
 * self-excluding semijoin that drops symbol<->symbol edges (their endpoints live
 * in the `symbols` table, not `entries`) and any dangling edge, with no hardcoded
 * rel allowlist. Edge shape becomes { from, to, rel, label }.
 *
 * Temp-DB pattern mirrors supersede-recall.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-edge-export-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.ts')
const { getAllForGraph, fileEntryId } = await import('../../server/graph/sync.ts')

getDb()

const insMem = (id: string) =>
  run(
    `INSERT INTO entries (id,name,kind,description,content,source,scope,updatedAt,syncedAt,authorship,outcome,outcome_text,agent_id,session_id,pinned,engagement,machine,content_hash)
     VALUES (?, ?, 'memory', '', '', '', 'user', 0, 0, '', '', '', '', '', 0, 0, '', '')`,
    id, id,
  )
const insFile = (p: string) =>
  run(
    `INSERT INTO entries (id,name,kind,description,content,source,scope,updatedAt,syncedAt,authorship,outcome,outcome_text,agent_id,session_id,pinned,engagement,machine,content_hash)
     VALUES (?, ?, 'file', '', '', '', '', 0, 0, '', '', '', '', '', 0, 0, '', '')`,
    fileEntryId(p), p,
  )
const edge = (src: string, dst: string, rel: string) =>
  run(`INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, ?)`, src, dst, rel)
const linksTo = (src: string, dst: string, label: string) =>
  run(`INSERT OR IGNORE INTO edges (src, dst, rel, label) VALUES (?, ?, 'LINKS_TO', ?)`, src, dst, label)

const F = '/repo/mentioned.ts'
insMem('m:a'); insMem('m:b'); insMem('m:c'); insFile(F)
const FID = fileEntryId(F)

edge('m:a', FID, 'MENTIONS_FILE')        // memory -> file (both entries)  -> EXPORT
edge('m:a', 'm:b', 'CONTRADICTS')         // memory -> memory (both entries) -> EXPORT
linksTo('m:a', 'm:c', 'see-also')         // memory -> memory LINKS_TO        -> EXPORT (with label)
edge('sym:1', 'sym:2', 'CALLS')           // symbol -> symbol, neither in entries -> EXCLUDE
linksTo('m:a', 'ghost', 'dangling')       // LINKS_TO whose dst absent from entries -> EXCLUDE

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const { edges } = await getAllForGraph()
const find = (from: string, to: string) =>
  edges.find((e: any) => e.from === from && e.to === to)

// ── 1. all entries<->entries typed edges are emitted, carrying rel ──────────────
{
  const mf = find('m:a', FID)
  assert.ok(mf, 'MENTIONS_FILE edge (memory->file) is exported')
  assert.equal((mf as any).rel, 'MENTIONS_FILE', 'edge carries its rel')
  ok('MENTIONS_FILE entries<->entries edge exported with rel')
}
{
  const c = find('m:a', 'm:b')
  assert.ok(c, 'CONTRADICTS edge (memory->memory) is exported')
  assert.equal((c as any).rel, 'CONTRADICTS', 'edge carries its rel')
  ok('CONTRADICTS entries<->entries edge exported with rel')
}
{
  const l = find('m:a', 'm:c')
  assert.ok(l, 'LINKS_TO edge still exported')
  assert.equal((l as any).rel, 'LINKS_TO', 'LINKS_TO carries rel')
  assert.equal((l as any).label, 'see-also', 'LINKS_TO label preserved')
  ok('LINKS_TO still exported with rel + label preserved')
}

// ── 2. symbol<->symbol edge (endpoints absent from entries) is NOT emitted ──────
{
  assert.equal(find('sym:1', 'sym:2'), undefined, 'symbol<->symbol CALLS edge excluded (endpoints not in entries)')
  ok('symbol<->symbol edge self-excluded by the semijoin')
}

// ── 3. dangling-dst edge is NOT emitted ─────────────────────────────────────────
{
  assert.equal(find('m:a', 'ghost'), undefined, 'dangling-dst LINKS_TO excluded (dst not in entries)')
  ok('dangling-dst edge excluded')
}

// ── 4. every emitted edge carries a string rel ──────────────────────────────────
{
  assert.ok(edges.length >= 3, 'at least the 3 valid edges are present')
  assert.ok(edges.every((e: any) => typeof e.rel === 'string' && e.rel.length > 0), 'every edge has a non-empty rel')
  ok('every exported edge carries a non-empty rel')
}

console.log(`\nOK edge-export.test.ts — ${passed} cases passed`)
process.exit(0)
