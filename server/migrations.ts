/**
 * On-boot migration runner — SQLite backend (no-op).
 *
 * Under the pre-SQLite backend this module carried a sequence of additive,
 * idempotent migrations (0001–0013) that ALTERed the graph store one
 * boot at a time, recording each in `~/.config/ckn/migrations.json`.
 *
 * The SQLite backend retires that machinery entirely:
 *   - The full, final schema is applied by `initSchema` (which `db.ts`'s
 *     `getDb()`/`openDb()` runs from `server/graph/schema.sql`) on every
 *     open. Every table/column/index is `CREATE ... IF NOT EXISTS`, so
 *     the schema is reached idempotently with no per-migration ALTER
 *     stepping — and none of the re-run SIGSEGV hazard the old
 *     `columnExists` guard existed to avoid.
 *   - Pre-existing graph DATA is carried over by the one-shot import
 *     script (pre-SQLite backend → SQLite), not by replaying migrations.
 *
 * `runMigrations()` and `runMigrationsCli()` keep their exact exports +
 * signatures: `server/index.ts` still `await runMigrations()` on boot,
 * and `bin/ckn-backfill-md.ts` still calls `runMigrationsCli()`. Both are
 * now no-ops that just log, so those call sites need no change.
 */

/**
 * No-op on the SQLite backend. The full schema is applied by `initSchema`
 * (server/graph/schema.sql) when `getDb()` opens; legacy data arrives via the
 * import script. Kept as an export + signature for `server/index.ts`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { backfillLinkage, type BackfillResult } from './graph/linkageBackfill.js'

// CKN_CONFIG_DIR lets a test redirect the migration-state file to a TEMP dir so it
// NEVER touches the real ~/.config/ckn/migrations.json. Without this isolation a
// test that boots the server (runMigrations) records the gate flag on the real box
// without an edge-creating run — which makes a later boot SKIP the real backfill.
const CONFIG_DIR = process.env.CKN_CONFIG_DIR || path.join(os.homedir(), '.config', 'ckn')
const MIGRATIONS_JSON = path.join(CONFIG_DIR, 'migrations.json')
const LINKAGE_ID = 'linkage-backfill-0009'

const appliedMigrations = (): Set<string> => {
  try {
    const j = JSON.parse(readFileSync(MIGRATIONS_JSON, 'utf8'))
    return new Set<string>(Array.isArray(j?.applied) ? j.applied : [])
  } catch {
    return new Set()
  }
}

const recordMigration = (id: string): void => {
  const done = appliedMigrations()
  done.add(id)
  try {
    mkdirSync(path.dirname(MIGRATIONS_JSON), { recursive: true })
    writeFileSync(MIGRATIONS_JSON, JSON.stringify({ applied: [...done] }, null, 2))
  } catch {
    /* best-effort — the backfill is idempotent even if the flag fails to persist */
  }
}

/**
 * Run the memory→file linkage backfill ("0009") once per install, recorded in
 * migrations.json. Idempotent regardless (keyed upserts), so the flag is a
 * scan-skip optimization, not a correctness gate. `force` re-runs it on demand
 * (the POST endpoint). Returns the result, or null when skipped (already applied).
 */
export const applyLinkageBackfill = async (force = false): Promise<BackfillResult | null> => {
  if (!force && appliedMigrations().has(LINKAGE_ID)) return null
  const r = await backfillLinkage()
  recordMigration(LINKAGE_ID)
  return r
}

export const runMigrations = async (): Promise<void> => {
  try {
    const r = await applyLinkageBackfill()
    if (r) {
      console.log(
        `[ckn] migration ${LINKAGE_ID}: scanned ${r.scanned}, edges +${r.edgesCreated} ~${r.edgesUpdated}, removed ${r.removed}`,
      )
    } else {
      console.log('[ckn] migrations: schema by initSchema; linkage-backfill-0009 already applied')
    }
  } catch (e: any) {
    // Never block boot on a migration error — the backfill is idempotent + can be
    // re-run via POST /api/graph/linkage-backfill or the next boot.
    console.error(`[ckn] migration ${LINKAGE_ID} failed (non-blocking): ${e?.message ?? e}`)
  }
}

/**
 * CLI export — preserved for `bin/ckn-backfill-md.ts` (the server-less update
 * path). No pending migrations exist on the SQLite backend; this just logs.
 */
export const runMigrationsCli = async (): Promise<void> => {
  console.log('[ckn migrations] checking for pending migrations…')
  await runMigrations()
  console.log('[ckn migrations] done')
}
