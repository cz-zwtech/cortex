import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { formatReport, parseFailures, runAll } from '../core/testRunner.js'

const REPO = path.resolve(import.meta.dirname, '..')

const scratch = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-runner-test-'))
  return { root, modulesDir: path.join(root, 'modules'), cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

/** Write a module that declares `tests`, with a test body we control. */
const writeModule = async (
  modulesDir: string,
  name: string,
  opts: { tests: string[]; body?: string },
) => {
  const dir = path.join(modulesDir, name)
  await fs.mkdir(path.join(dir, 'test'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'module.json'),
    JSON.stringify({ name, version: '1.0.0', requiresCore: '>=2.0.0', tests: opts.tests }),
  )
  if (opts.body !== undefined) {
    await fs.writeFile(path.join(dir, opts.tests[0]!), opts.body)
  }
  return dir
}

test('a module with passing tests reports PASS', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  await writeModule(s.modulesDir, 'good', {
    tests: ['test/ok.test.ts'],
    body: `import {test} from 'node:test'\nimport assert from 'node:assert/strict'\ntest('works', () => { assert.equal(1, 1) })\n`,
  })

  const report = await runAll({ modulesDir: s.modulesDir, repoRoot: REPO })

  assert.equal(report.ok, true)
  assert.equal(report.suites.length, 1)
  assert.equal(report.suites[0]?.suite, 'good')
  assert.equal(report.suites[0]?.passed, 1)
  assert.equal(report.suites[0]?.failed, 0)
})

test('a module with a failing test reports FAIL and is not swallowed', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  await writeModule(s.modulesDir, 'bad', {
    tests: ['test/no.test.ts'],
    body: `import {test} from 'node:test'\nimport assert from 'node:assert/strict'\ntest('breaks', () => { assert.equal(1, 2) })\n`,
  })

  const report = await runAll({ modulesDir: s.modulesDir, repoRoot: REPO })

  assert.equal(report.ok, false)
  assert.equal(report.suites[0]?.failed, 1)
  assert.notEqual(report.suites[0]?.exitCode, 0)
})

test('one failing module does not hide another passing one', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  await writeModule(s.modulesDir, 'alpha', {
    tests: ['test/a.test.ts'],
    body: `import {test} from 'node:test'\ntest('fine', () => {})\n`,
  })
  await writeModule(s.modulesDir, 'beta', {
    tests: ['test/b.test.ts'],
    body: `import {test} from 'node:test'\nimport assert from 'node:assert/strict'\ntest('nope', () => { assert.fail('boom') })\n`,
  })

  const report = await runAll({ modulesDir: s.modulesDir, repoRoot: REPO })

  assert.equal(report.suites.length, 2)
  const alpha = report.suites.find((x) => x.suite === 'alpha')!
  const beta = report.suites.find((x) => x.suite === 'beta')!
  assert.equal(alpha.exitCode, 0, 'a good module must still report its own result')
  assert.notEqual(beta.exitCode, 0)
  assert.equal(report.ok, false)
})

test('declaring a test file that does not exist is a DEFECT, not an absence', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  // No body written — the manifest promises a file that is not there.
  await writeModule(s.modulesDir, 'liar', { tests: ['test/missing.test.ts'] })

  const report = await runAll({ modulesDir: s.modulesDir, repoRoot: REPO })

  // Silently running the files that happen to exist would report green for a
  // suite that is partly imaginary.
  assert.equal(report.ok, false)
  assert.match(report.suites[0]!.error ?? '', /declares tests that do not exist/)
})

test('a module declaring no tests is reported, not silently green', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  await fs.mkdir(path.join(s.modulesDir, 'untested'), { recursive: true })
  await fs.writeFile(
    path.join(s.modulesDir, 'untested', 'module.json'),
    JSON.stringify({ name: 'untested', version: '1.0.0', requiresCore: '>=2.0.0' }),
  )

  const report = await runAll({ modulesDir: s.modulesDir, repoRoot: REPO })

  assert.equal(report.suites[0]?.error, 'module declares no tests')
  // Not having tests is not a failure — but it must be visible.
  assert.equal(report.ok, true)
})

test('no modules installed is a clean, empty run', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  const report = await runAll({ modulesDir: s.modulesDir, repoRoot: REPO })
  assert.equal(report.ok, true)
  assert.deepEqual(report.suites, [])
})

test('a test that hangs synchronously is killed at the suite deadline and reported, not left running', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  // A synchronous spin never yields, so node:test's own per-test timer cannot
  // fire. This is the shape that ran for nine weeks in the lab container.
  const marker = `cortex-hang-${process.pid}-${Date.now()}`
  await writeModule(s.modulesDir, 'hangs', {
    tests: ['test/hang.test.ts'],
    body: `import {test} from 'node:test'\ntest('${marker}', () => { for (;;) {} })\n`,
  })

  const started = Date.now()
  const report = await runAll({ modulesDir: s.modulesDir, repoRoot: REPO, suiteTimeoutMs: 4_000 })

  assert.equal(report.ok, false)
  assert.match(report.suites[0]?.error ?? '', /exceeded 4s and was killed/)
  assert.ok(Date.now() - started < 20_000, 'the runner returned instead of waiting on the hang')

  // And nothing is left spinning: the whole process group was killed.
  await new Promise((r) => setTimeout(r, 500))
  const { execSync } = await import('node:child_process')
  const survivors = execSync(`ps -eo args`, { encoding: 'utf-8' }).split('\n').filter((l) => l.includes('hang.test.ts') && l.includes(s.root))
  assert.deepEqual(survivors, [], 'no test process outlived its run')
})

test('a failing test is named in the report, with its error, so a flaky failure leaves a trace', () => {
  const tap = [
    'ok 1 - fine',
    'not ok 2 - the flaky one',
    '  ---',
    '  duration_ms: 5',
    "  error: 'timed out waiting for: d has it'",
    '  ...',
    'not ok 3 - no error line',
  ].join('\n')
  assert.deepEqual(parseFailures(tap), ["the flaky one: 'timed out waiting for: d has it'", 'no error line'])
  const multi = ['not ok 1 - multi', '  ---', '  error: |-', '    Expected values to be strictly equal:', "    + 'a'", "    - 'b'", '  code: x'].join('\n')
  assert.deepEqual(parseFailures(multi), ["multi: Expected values to be strictly equal: + 'a' - 'b' code: x"])
  const text = formatReport({
    suites: [{ suite: 'mesh', files: ['x'], passed: 1, failed: 1, exitCode: 1, durationMs: 1, failures: ['the flaky one: boom'] }],
    ok: false, totalPassed: 1, totalFailed: 1,
  } as never)
  assert.match(text, /not ok: the flaky one: boom/)
})
