#!/usr/bin/env node
/**
 * Sequential bus-test runner with CKN_FORBID_DEFAULT_DB=1 wired in.
 *
 * Bus tests bind fixed ports (3092/3094/3095/3096/3097) — parallel execution
 * causes port collisions. Each test runs one at a time; the runner exits non-zero
 * on the first failure (fail-fast).
 *
 * Set the DB sentinel for every child so a misconfigured test that would open
 * the real ~/.config/ckn/graph.sqlite fails loudly instead of silently polluting.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(__dirname)
const BUS_DIR = join(ROOT, 'test', 'bus')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

// Bus tests spawn the real server (server/index.ts), which runs runMigrations on
// listen — the memory→file linkage backfill records its gate flag in
// migrations.json. Redirect that to a TEMP config dir so a test boot NEVER writes
// the real ~/.config/ckn/migrations.json (which would make a later real boot SKIP
// the backfill — the test-user shipping bug). Servers inherit this via {...process.env}.
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ckn-bustest-config-'))

const files = readdirSync(BUS_DIR)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => join(BUS_DIR, f))

let passed = 0
let failed = 0

for (const file of files) {
  const rel = file.slice(ROOT.length + 1)
  const result = spawnSync(TSX, [file], {
    cwd: ROOT,
    env: { ...process.env, CKN_FORBID_DEFAULT_DB: '1', CKN_CONFIG_DIR: TEST_CONFIG_DIR },
    stdio: 'inherit',
  })
  if (result.status === 0 && result.signal == null) {
    console.log(`PASS  ${rel}`)
    passed++
  } else {
    const why = result.signal ? `signal ${result.signal}` : `exit ${result.status}`
    console.error(`FAIL  ${rel}  (${why})`)
    failed++
    console.error(`\n${failed} test(s) failed — stopping.`)
    process.exit(1)
  }
}

console.log(`\n${passed} test(s) passed`)
