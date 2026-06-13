#!/usr/bin/env tsx
/**
 * ckn-backfill-md — server-less migration runner.
 *
 * Equivalent to what `runMigrations()` does on server boot, but runnable
 * as a standalone CLI:
 *
 *     npx tsx bin/ckn-backfill-md.ts
 *
 * Useful when the engineer prefers not to start the daemon, or when
 * running this on a CI / one-shot machine. The migration state file at
 * `~/.config/ckn/migrations.json` is shared between this CLI and the
 * server boot path, so running here first means the server boot path is
 * a no-op afterwards (and vice versa).
 */
import { runMigrationsCli } from '../server/migrations.js'

runMigrationsCli().catch((e) => {
  console.error('[ckn migrations] fatal:', e?.message ?? e)
  process.exit(1)
})
