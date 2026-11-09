/**
 * scripts/v1-check.mjs, run by npm as V2's preinstall: it stops an install while V1 is still wired on
 * the machine (a V1 updater pulling V2 runs `npm ci`, which runs this first), and lets every other
 * install through.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v1-check-'))

const machine = (opts: { hook?: boolean; localHook?: boolean; home?: string; unit?: 'v1' | 'other' } = {}) => {
  const home = tmp()
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const settings = (cmd: string) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd }] }] } })
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), settings(opts.hook ? 'exec "$H/node_modules/.bin/tsx" "$H/bin/ckn-sync.ts"' : 'x/bin/cortex-hook.ts Stop'))
  if (opts.localHook) fs.writeFileSync(path.join(home, '.claude', 'settings.local.json'), settings('exec "$H/bin/ckn-aware.ts"'))
  if (opts.home) {
    fs.mkdirSync(path.join(home, '.config', 'ckn'), { recursive: true })
    fs.writeFileSync(path.join(home, '.config', 'ckn', 'home'), opts.home + '\n')
  }
  // A stand-in systemctl: it knows one unit, or none.
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  const unit = opts.unit === 'v1' ? 'ExecStart=/x/bin/cortex-runner.sh' : opts.unit === 'other' ? 'ExecStart=/usr/bin/something-else' : ''
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\n[ -n "${unit}" ] || exit 1\ncase "$*" in *cat*) echo "${unit}";; esac\nexit 0\n`, { mode: 0o755 })
  return { home, bin }
}

const run = (m: { home: string; bin: string }, env: Record<string, string> = {}) => {
  const { CI: _ci, CORTEX_SKIP_V1_CHECK: _skip, ...rest } = process.env
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'v1-check.mjs')], {
    encoding: 'utf-8',
    cwd: root,
    env: { ...rest, HOME: m.home, PATH: `${m.bin}:/usr/bin:/bin`, ...env },
  })
}

test('passes on a machine with no V1 wiring', () => {
  assert.equal(run(machine()).status, 0)
})

test('passes where there is no Claude config at all', () => {
  const m = machine()
  fs.rmSync(path.join(m.home, '.claude'), { recursive: true })
  assert.equal(run(m).status, 0)
})

test('refuses while a V1 hook is in settings.json, and says what to do', () => {
  const r = run(machine({ hook: true }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /docs\/migrating-from-v1\.md/)
  assert.match(r.stderr, /v1-final/)
})

test('refuses while a V1 hook is in settings.local.json', () => {
  assert.equal(run(machine({ localHook: true })).status, 1)
})

test("refuses while V1's systemd unit is installed", () => {
  assert.equal(run(machine({ unit: 'v1' })).status, 1)
})

test('a cortex.service that is not V1 is left alone', () => {
  assert.equal(run(machine({ unit: 'other' })).status, 0)
})

test("refuses while V1's home pointer names this checkout", () => {
  assert.equal(run(machine({ home: root })).status, 1)
})

test('a home pointer to another folder is not this checkout', () => {
  assert.equal(run(machine({ home: '/somewhere/else' })).status, 0)
})

test('CI and CORTEX_SKIP_V1_CHECK=1 always pass', () => {
  const m = machine({ hook: true, unit: 'v1' })
  assert.equal(run(m, { CI: 'true' }).status, 0)
  assert.equal(run(m, { CORTEX_SKIP_V1_CHECK: '1' }).status, 0)
})
