/**
 * The test runner — core runs what modules declare.
 *
 * A module lists its tests in the manifest; core finds and runs them. This is
 * the thing that makes the `tests` field mean something, and it exists BEFORE
 * the first real module rather than after, so no module is ever built without a
 * gate.
 *
 * Two V1 lessons are designed in here rather than inherited:
 *
 *  - V1's `tsc` never typechecked `test/`, so tests drifted from the code they
 *    described and nobody noticed. V2's tsconfig includes `test`, and the
 *    runner reports a typecheck result alongside the run.
 *  - V1 had a runner for the bus suite and NO runner at all for the other 134
 *    files, which had to be hand-enumerated. Declaring tests in the manifest
 *    makes "which tests exist" a question with one answer.
 *
 * The runner is deliberately dumb: it discovers, spawns, and reports. It does
 * not own assertions, a DSL, or a plugin system — node's built-in test runner
 * already does that, and a bespoke framework would be scope we were told not to
 * grow.
 */

import os from 'node:os'
import fsSync from 'node:fs'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { discover } from './discover.js'

export type SuiteResult = {
  /** Module name, or 'core' for core's own suite. */
  suite: string
  files: string[]
  passed: number
  failed: number
  /** Non-zero means the suite failed, including "could not run". */
  exitCode: number
  /** Set when the suite could not be run at all, as opposed to failing. */
  error?: string
  durationMs: number
  /** Each failing test's name and the first line of its error, so a flaky failure leaves a trace. */
  failures?: string[]
}

export type RunReport = {
  suites: SuiteResult[]
  totalPassed: number
  totalFailed: number
  ok: boolean
}

/** Parse node:test's TAP-ish summary. Counting from output beats trusting exit codes alone. */
/** `not ok N - name` lines with the first error line under each. */
export const parseFailures = (output: string): string[] => {
  const lines = output.split('\n')
  const out: string[] = []
  lines.forEach((l, i) => {
    const m = /^\s*not ok \d+ - (.*)$/.exec(l)
    if (!m) return
    const at = lines.slice(i + 1, i + 15).findIndex((x) => /^\s*error:/.test(x))
    if (at < 0) return void out.push(m[1]!)
    let err = lines[i + 1 + at]!.trim().replace(/^error:\s*/, '')
    // A multi-line error ("error: |-") continues on the more-indented lines below it.
    if (err === '|-' || err === '|') err = lines.slice(i + 2 + at, i + 6 + at).map((x) => x.trim()).filter(Boolean).join(' ')
    out.push(`${m[1]}: ${err}`)
  })
  return out
}

const parseCounts = (output: string): { passed: number; failed: number } => {
  const pass = /^# pass (\d+)$/m.exec(output)
  const fail = /^# fail (\d+)$/m.exec(output)
  return { passed: pass ? Number(pass[1]) : 0, failed: fail ? Number(fail[1]) : 0 }
}

/**
 * Spawn the test child.
 *
 * `cwd` is ALWAYS the repo root, never the module directory, and the reason is
 * not obvious enough to leave implicit: tsx picks its module format from the
 * nearest `package.json`. A module directory that does not carry one (which is
 * the normal case — a module is a folder, not an npm package) resolves as CJS,
 * and every ESM test file in it fails to transform with "Top-level await is
 * currently not supported with the cjs output format".
 *
 * Requiring each module to ship a package.json purely to be testable would be
 * a tax on module authors for a detail of our runner. Absolute file paths plus
 * a fixed cwd costs nothing and keeps `tests` in the manifest working for a
 * module that is just a directory.
 */
/**
 * Wall-clock limit for one suite, and the per-test limit handed to node:test.
 *
 * TWO LIMITS, BECAUSE ONE CANNOT SEE THE OTHER'S FAILURE. node:test's per-test
 * timeout is a timer on the test's own event loop, so it catches an async hang
 * and is blind to a synchronous one: a test spinning inside a syscall never
 * yields, and the timer never fires. That is not hypothetical. Three test
 * processes in the lab container ran at full CPU for nine weeks on a recursive
 * mkdir under /proc, holding about three cores, because nothing outside them
 * had a deadline. The suite deadline is enforced from THIS process and kills the
 * child's whole process group, so a hung test cannot outlive its run.
 */
export const SUITE_TIMEOUT_MS = Number(process.env.CORTEX_TEST_SUITE_TIMEOUT_MS ?? 300_000)
export const TEST_TIMEOUT_MS = Number(process.env.CORTEX_TEST_TIMEOUT_MS ?? 60_000)

const runFiles = async (
  suite: string,
  cwd: string,
  files: string[],
  onOutput?: (chunk: string) => void,
  suiteTimeoutMs = SUITE_TIMEOUT_MS,
): Promise<SuiteResult> => {
  const started = Date.now()

  if (files.length === 0) {
    return { suite, files, passed: 0, failed: 0, exitCode: 0, durationMs: 0 }
  }

  return new Promise<SuiteResult>((resolve) => {
    // NODE_TEST_CONTEXT must be stripped. When the runner is itself invoked
    // from inside `node --test` (which happens whenever the runner's own tests
    // run), the child inherits it and node:test switches to the child reporter
    // protocol — so the child emits v8-serialized frames instead of the TAP
    // summary this function parses, and a passing suite is read as zero tests.
    // The symptom is a green suite reported as a failure, which is the worst
    // direction for a test runner to be wrong in.
    // The suite never sees the developer's real roots: a test that forgets to
    // isolate itself still lands in a temp dir (the default memory roots follow
    // CLAUDE_CONFIG_DIR) (incident 2026-10-13, where a
    // spawned dispatcher consumed 269 real memory files).
    const sandbox = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cortex-suite-'))
    for (const d of ['claude/memory', 'state']) fsSync.mkdirSync(path.join(sandbox, d), { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NO_COLOR: '1',
      CLAUDE_CONFIG_DIR: path.join(sandbox, 'claude'),
      CKN_STATE_DIR: path.join(sandbox, 'state'),
      CORTEX_UNDER_TEST: '1',
    }
    // Inherited overrides could point a suite at real data; none survive.
    delete env.CKN_MEMORY_DIRS
    delete env.CKN_DB_PATH
    // Fail closed: every root a suite can resolve must be inside the sandbox.
    for (const k of ['CLAUDE_CONFIG_DIR', 'CKN_STATE_DIR'] as const) {
      if (!env[k]!.startsWith(sandbox)) throw new Error(`test runner refused to start: ${k} is not sandboxed`)
    }
    delete env.NODE_TEST_CONTEXT

    // detached: the child leads its own process group, so the deadline can kill
    // npx, tsx and every test process under them in one signal. Killing only
    // the direct child would orphan the hung grandchild, which is exactly the
    // tree that sat in the lab container.
    const child = spawn('npx', ['tsx', '--test', `--test-timeout=${TEST_TIMEOUT_MS}`, ...files], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, suiteTimeoutMs)

    let output = ''
    child.stdout.on('data', (d: Buffer) => {
      output += d.toString()
      onOutput?.(d.toString())
    })
    child.stderr.on('data', (d: Buffer) => {
      output += d.toString()
    })

    child.on('error', (err) => {
      clearTimeout(deadline)
      resolve({
        suite,
        files,
        passed: 0,
        failed: 0,
        exitCode: 1,
        error: `could not run: ${err.message}`,
        durationMs: Date.now() - started,
      })
    })

    child.on('close', (code) => {
      clearTimeout(deadline)
      const { passed, failed } = parseCounts(output)
      const failures = parseFailures(output)
      if (timedOut) {
        resolve({
          suite,
          files,
          passed,
          failed,
          exitCode: 1,
          error: `suite exceeded ${Math.round(suiteTimeoutMs / 1000)}s and was killed (a test hung)`,
          durationMs: Date.now() - started,
        })
        return
      }
      resolve({
        suite,
        files,
        passed,
        failed,
        exitCode: code ?? 1,
        // A suite that exits non-zero while reporting zero failures did not
        // "pass with an odd exit code" — it crashed before reporting, and
        // treating that as success is how a broken suite looks green.
        error: code !== 0 && failed === 0 ? 'suite exited non-zero without reporting failures' : undefined,
        durationMs: Date.now() - started,
        ...(failures.length ? { failures } : {}),
      })
    })
  })
}

/** Resolve a module's declared test globs to real files, dropping missing ones. */
const resolveTests = async (dir: string, declared: string[]): Promise<{ files: string[]; missing: string[] }> => {
  const files: string[] = []
  const missing: string[] = []
  for (const rel of declared) {
    const abs = path.join(dir, rel)
    try {
      await fs.access(abs)
      files.push(abs)
    } catch {
      missing.push(rel)
    }
  }
  return { files, missing }
}

export type RunOptions = {
  modulesDir: string
  repoRoot: string
  /** Core's own test files, relative to repoRoot. */
  coreTests?: string[]
  onOutput?: (chunk: string) => void
  /** Per-suite wall-clock limit. Defaults to SUITE_TIMEOUT_MS. */
  suiteTimeoutMs?: number
}

export const runAll = async (opts: RunOptions): Promise<RunReport> => {
  const suites: SuiteResult[] = []

  if (opts.coreTests?.length) {
    const { files } = await resolveTests(opts.repoRoot, opts.coreTests)
    suites.push(await runFiles('core', opts.repoRoot, files, opts.onOutput, opts.suiteTimeoutMs))
  }

  const { found, rejected } = await discover(opts.modulesDir)

  // A REJECTED module appears in the report as a failure rather than vanishing
  // from it. Discovery already reports these; an earlier revision destructured
  // only `found`, so a module with a malformed manifest was silently absent and
  // the run went green over a smaller suite than anyone believed. Same
  // silent-scope-reduction defect as the runner resolving a modules directory
  // that did not exist — one layer further down, and invisible for the same
  // reason: the information existed and nothing consumed it.
  for (const r of rejected) {
    suites.push({
      suite: r.name || r.dir,
      files: [],
      passed: 0,
      failed: 0,
      exitCode: 1,
      error: `rejected at discovery, so its tests never ran: ${r.errors.join('; ')}`,
      durationMs: 0,
    })
  }

  for (const { dir, manifest } of found) {
    const { files, missing } = await resolveTests(dir, manifest.tests)

    if (missing.length) {
      // A manifest promising tests that do not exist is a defect, not an
      // absence — silently running the ones that happen to be there would
      // report green for a suite that is partly imaginary.
      suites.push({
        suite: manifest.name,
        files,
        passed: 0,
        failed: 0,
        exitCode: 1,
        error: `manifest declares tests that do not exist: ${missing.join(', ')}`,
        durationMs: 0,
      })
      continue
    }

    if (files.length === 0) {
      suites.push({
        suite: manifest.name,
        files: [],
        passed: 0,
        failed: 0,
        exitCode: 0,
        error: 'module declares no tests',
        durationMs: 0,
      })
      continue
    }

    // repoRoot, not `dir` — see the note on runFiles.
    suites.push(await runFiles(manifest.name, opts.repoRoot, files, opts.onOutput, opts.suiteTimeoutMs))
  }

  const totalPassed = suites.reduce((n, s) => n + s.passed, 0)
  const totalFailed = suites.reduce((n, s) => n + s.failed, 0)
  return {
    suites,
    totalPassed,
    totalFailed,
    ok: suites.every((s) => s.exitCode === 0),
  }
}

export const formatReport = (report: RunReport): string => {
  const lines: string[] = []
  for (const s of report.suites) {
    const status = s.exitCode === 0 ? 'PASS' : 'FAIL'
    const detail = s.error ? ` — ${s.error}` : ` — ${s.passed} passed, ${s.failed} failed`
    lines.push(`  ${status}  ${s.suite}${detail} (${s.files.length} file(s), ${s.durationMs}ms)`)
    for (const f of s.failures ?? []) lines.push(`          not ok: ${f}`)
  }
  lines.push('')
  lines.push(
    report.ok
      ? `  ALL GREEN — ${report.totalPassed} passed across ${report.suites.length} suite(s)`
      : `  FAILED — ${report.totalFailed} failed, ${report.totalPassed} passed`,
  )
  return lines.join('\n')
}
