#!/usr/bin/env tsx
/**
 * `npm test` — run core's suite plus every installed module's declared tests.
 *
 * Deliberately NOT hardcoding a file list: core's own tests are globbed, and
 * module tests come from their manifests. V1's runner enumerated by hand for
 * one suite and not at all for the other, which is how a suite drifts out of
 * the gate without anyone deciding to remove it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE FAILS LOUD ABOUT ITS OWN SCOPE
 *
 * This runner silently narrowed itself. `CKN_HOME` in the lab container points
 * at the state volume, so the default invocation resolved a modules directory
 * that does not exist, ran CORE ONLY, and printed ALL GREEN. Two thirds of the
 * suite went unrun and nothing said so. It was caught by ARITHMETIC — tests were
 * added and the count did not move — not by anything the runner reported.
 *
 * The standing rule this cost us:
 *
 *   ANY MECHANISM THAT CAN SILENTLY REDUCE ITS OWN SCOPE MUST REPORT THE
 *   REDUCTION.
 *
 * Fourth instance in this project, after: settings.json "true" because nothing
 * had written it; a timeout budget inert because the loop it guarded blocked the
 * event loop; and a test asserting "not emitted" while the row persisted.
 *
 * So: a missing modules directory is an ERROR, not an empty list. A green result
 * on an undeclared subset is worse than a red one — red gets investigated.
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { exitOnHelp } from '../core/help.js'
import { runAll, formatReport } from '../core/testRunner.js'

exitOnHelp(`usage: cortex-test
  runs core's tests (test/*.test.ts) and every installed module's declared tests.
  CKN_MODULES_DIR names the modules directory (default <state>/modules); a missing one is an error`)

const repoRoot = path.resolve(import.meta.dirname, '..')

const explicit = process.env.CKN_MODULES_DIR
const modulesDir =
  explicit ?? path.join(process.env.CKN_HOME ?? path.join(os.homedir(), '.config', 'ckn'), 'modules')

const exists = async (p: string) => {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

const coreTests = (await fs.readdir(path.join(repoRoot, 'test')))
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => path.join('test', f))

// Report the scope BEFORE running, so a narrowed run is visible even if the
// process dies mid-suite.
console.log('cortex test')
console.log(`  core        ${coreTests.length} file(s) in ${path.join(repoRoot, 'test')}`)
console.log(`  modules dir ${modulesDir}${explicit ? ' (CKN_MODULES_DIR)' : ' (default)'}`)

if (!(await exists(modulesDir))) {
  const repoModules = path.join(repoRoot, 'modules')
  console.error(
    [
      '',
      `ERROR: modules directory does not exist: ${modulesDir}`,
      '',
      'Refusing to run core-only and report green. A pass over an undeclared',
      'subset is indistinguishable from a real pass, which is exactly how this',
      'suite once reported ALL GREEN with two thirds of itself unrun.',
      '',
      (await exists(repoModules))
        ? `Did you mean:  CKN_MODULES_DIR=${repoModules}`
        : 'Set CKN_MODULES_DIR to the directory holding installed modules.',
      '',
    ].join('\n'),
  )
  process.exit(2)
}

// cortex-install links each module, so a link to a directory is a module too.
const installed = (
  await Promise.all(
    (await fs.readdir(modulesDir)).sort().map(async (name) => ((await exists(path.join(modulesDir, name))) ? name : undefined)),
  )
).filter((n): n is string => !!n)

// The same rule, the other way: the installed modules can be another checkout's
// (after a cutover they are the shared deploy). Run from a dev checkout, this
// would test that code and report its green as this checkout's.
const elsewhere = (
  await Promise.all(installed.map(async (name) => ({ name, real: await fs.realpath(path.join(modulesDir, name)) })))
).filter((m) => !m.real.startsWith(repoRoot + path.sep))
if (elsewhere.length && !process.env.CKN_TEST_OTHER_CHECKOUT) {
  console.error(
    [
      '',
      `ERROR: these modules are not this checkout's (${repoRoot}):`,
      ...elsewhere.map((m) => `  ${m.name} -> ${m.real}`),
      '',
      `To test this checkout:  CKN_MODULES_DIR=${path.join(repoRoot, 'modules')}`,
      'To test those modules on purpose:  CKN_TEST_OTHER_CHECKOUT=1',
      '',
    ].join('\n'),
  )
  process.exit(2)
}

console.log(
  `  modules     ${installed.length} present${installed.length ? `: ${installed.join(', ')}` : ''}\n`,
)

const report = await runAll({ modulesDir, repoRoot, coreTests })

console.log(formatReport(report))
console.log(`\n  ran ${report.suites.length} suite(s) over ${installed.length} module dir(s)`)

process.exit(report.ok ? 0 : 1)
