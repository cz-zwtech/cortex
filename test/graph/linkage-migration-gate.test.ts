#!/usr/bin/env tsx
/**
 * 0009 migration GATE (the test-user shipping-correctness fix). Two invariants:
 *   1. Tests must use a TEMP config dir, NEVER the real ~/.config/ckn/migrations.json
 *      — the leak that pre-set the 0009 flag on the real box (bus tests boot the
 *      server, which runs runMigrations, with no config isolation). migrations.ts
 *      honors CKN_CONFIG_DIR so a test can redirect it.
 *   2. Flag-after-success on a CLEAN gate: runMigrations actually RUNS the backfill,
 *      creates edges, and records the flag AFTER — and a second run is a skip
 *      (idempotent). A fresh install / test user must get the edges, not a flag
 *      recorded without a run.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-gate-'))
process.env.HOME = dir
process.env.CKN_CONFIG_DIR = path.join(dir, 'config') // the temp config — never the real one
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
const MIGRATIONS_JSON = path.join(process.env.CKN_CONFIG_DIR, 'migrations.json')

const { run, get } = await import('../../server/graph/db.ts')
const { applyLinkageBackfill, runMigrations } = await import('../../server/migrations.ts')

const COLS =
  `(id, name, kind, description, content, source, scope, updatedAt, syncedAt, authorship, outcome, outcome_text, agent_id, session_id, pinned, engagement, machine, content_hash)`
run(
  `INSERT INTO entries ${COLS} VALUES ('mem:g1','g1','memory','','I touched \`server/graph/sync.ts\` today.','', 'user', 0, 0, 'human','','','','',0,0,'','')`,
)

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. clean gate (no migrations.json) → runMigrations RUNS + creates edges + flags after
{
  assert.ok(!fs.existsSync(MIGRATIONS_JSON), 'precondition: no migrations.json yet (clean gate)')
  const r = await applyLinkageBackfill()
  assert.ok(r, 'clean gate RUNS the backfill (not skipped)')
  assert.ok(r!.edgesCreated >= 1, `created the derived edge (got ${r!.edgesCreated})`)
  assert.ok(get(`SELECT 1 FROM edges WHERE src='mem:g1' AND dst='file:server_graph_sync.ts' AND rel='MENTIONS_FILE'`), 'edge exists post-run')
  ok('clean gate runs the backfill and creates edges')
}

// ── 2. the flag is recorded AFTER the successful run — in the TEMP config dir
{
  assert.ok(fs.existsSync(MIGRATIONS_JSON), 'migrations.json written to the TEMP config dir (CKN_CONFIG_DIR)')
  const j = JSON.parse(fs.readFileSync(MIGRATIONS_JSON, 'utf8'))
  assert.ok((j.applied ?? []).includes('linkage-backfill-0009'), 'flag recorded after the run')
  // the real ~/.config/ckn lives under the user's real HOME; HOME is redirected to
  // the temp dir here, so we never wrote the real one.
  ok('flag recorded after success, in the temp config (never the real migrations.json)')
}

// ── 3. second run is a SKIP (idempotent gate) — no duplicate work
{
  const r2 = await applyLinkageBackfill()
  assert.equal(r2, null, 'already-applied gate → skip (returns null)')
  await runMigrations() // exercises the boot path; must not throw on an applied gate
  ok('re-run skips via the recorded flag (idempotent)')
}

console.log(`\nOK linkage-migration-gate.test.ts — ${passed} assertions passed`)
