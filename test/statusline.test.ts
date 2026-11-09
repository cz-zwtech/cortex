import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { isolatedEnv } from './isolatedEnv.js'

const REPO = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(REPO, 'bin', 'cortex-statusline.sh')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const state = (opts: { member?: string; watch?: object; count?: string }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sl-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'data', 'memory'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'data', 'comms', 'watch'), { recursive: true })
  if (opts.count) fs.writeFileSync(path.join(dir, 'data', 'memory', 'count'), opts.count)
  if (opts.member) fs.writeFileSync(path.join(dir, 'data', 'comms', 'sessions.json'), JSON.stringify({ s1: opts.member }))
  if (opts.member && opts.watch) fs.writeFileSync(path.join(dir, 'data', 'comms', 'watch', `${opts.member}.json`), JSON.stringify(opts.watch))
  // The segments cortex-install links for installed memory and comms.
  fs.mkdirSync(path.join(dir, 'statusline.d'))
  fs.symlinkSync(path.join(REPO, 'modules', 'memory', 'statusline.sh'), path.join(dir, 'statusline.d', '10-memory.sh'))
  fs.symlinkSync(path.join(REPO, 'modules', 'comms', 'statusline.sh'), path.join(dir, 'statusline.d', '20-comms.sh'))
  return dir
}

const render = (dir: string): Promise<string> =>
  new Promise((ok) => {
    const c = spawn('bash', [SCRIPT], { env: isolatedEnv({ CKN_STATE_DIR: dir }).env })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.on('close', () => ok(out.replace(/\x1b\[[0-9;]*m/g, '')))
    c.stdin.end(JSON.stringify({ session_id: 's1' }))
  })

test('a member whose watcher ended, went stale or was never armed shows bus off', async () => {
  assert.match(await render(state({ member: 'docs1', watch: { beatAt: Date.now(), endedAt: Date.now() } })), /● bus off/)
  assert.match(await render(state({ member: 'docs1', watch: { beatAt: Date.now() - 120_000 } })), /● bus off/)
  assert.match(await render(state({ member: 'docs1' })), /● bus off/, 'never armed')
})

test('a session in no role has nothing to listen for, and is not shown as a fault', async () => {
  assert.equal(await render(state({ count: '5' })), 'cortex  5 mem  ○ bus ○ mesh off')
})

// ── the bus is the local mesh log; the daemon links peers ──────────

const meshState = (opts: { daemon: boolean; live?: boolean }) => {
  const dir = state({ member: 'docs-1', watch: { beatAt: Date.now() }, count: '7' })
  const mesh = path.join(dir, 'data', 'mesh')
  fs.mkdirSync(mesh, { recursive: true })
  if (opts.daemon) {
    fs.writeFileSync(path.join(mesh, 'daemon.pid'), String(process.pid))
    fs.writeFileSync(path.join(mesh, 'status.json'), JSON.stringify({ running: true, links: opts.live ? [{ url: 'x', live: true }] : [] }))
  }
  return dir
}

test('mesh mode: no V1 server needed; a live peer link is green, none is honestly local', async () => {
  assert.equal(await render(meshState({ daemon: true, live: true })), 'cortex  7 mem  ● bus ● mesh · docs-1')
  assert.equal(await render(meshState({ daemon: true })), 'cortex  7 mem  ● bus ○ local · docs-1')
})

test('mesh mode: a stopped daemon says mesh off, and the bus still works locally', async () => {
  assert.equal(await render(meshState({ daemon: false })), 'cortex  7 mem  ● bus ○ mesh off · docs-1')
})

test('core alone prints only "cortex"; a module removed takes its segment with it', async () => {
  const dir = state({ count: '3' })
  assert.equal(await render(dir), 'cortex  3 mem  ○ bus ○ mesh off')
  fs.rmSync(path.join(dir, 'statusline.d', '20-comms.sh'))
  assert.equal(await render(dir), 'cortex  3 mem')
  fs.rmSync(path.join(dir, 'statusline.d'), { recursive: true })
  assert.equal(await render(dir), 'cortex')
})
