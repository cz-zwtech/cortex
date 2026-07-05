#!/usr/bin/env tsx
/** A `feedback` memory with top-level `engagement: true` syncs with engagement=1; untagged → 0.
 *  Boots via the central ephemeral harness (#154 part b) so the spawned server can
 *  never register real user state / hijack the home pointer the way it once did. */
import assert from 'node:assert/strict'
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { spawnEphemeralServer } from '../_ephemeralServer.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-eng-home-'))
const memDir = path.join(home, '.claude', 'memory'); fs.mkdirSync(memDir, { recursive: true })
fs.writeFileSync(path.join(memDir, 'response-brevity.md'),
  '---\nname: response-brevity\ndescription: Concise, no sycophancy; brief-first; options with pros/cons\ntype: feedback\nengagement: true\n---\nbody\n')
fs.writeFileSync(path.join(memDir, 'some-note.md'),
  '---\nname: some-note\ndescription: just a note\ntype: feedback\n---\nbody\n')

const srv = await spawnEphemeralServer({ port: 3096, home })
const BASE = srv.baseUrl
const cleanup = () => { srv.stop(); fs.rmSync(home, { recursive: true, force: true }) }
const runSync = () => new Promise<void>((res, rej) => {
  const cp = spawn('node_modules/.bin/tsx', ['bin/ckn-sync.ts'], { cwd: repoRoot, env: srv.env, stdio: 'ignore' })
  cp.on('close', (c) => (c === 0 ? res() : rej(new Error('sync exit ' + c))))
})

let passed = 0; const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }
try {
  await runSync()
  const all = await fetch(`${BASE}/api/graph/search?q=response-brevity`).then((r) => r.json())
  assert.ok(all.entries?.length, 'tagged memory synced')
  // engagement endpoint (built in Task 3) is the cleanest read; here assert via it once it exists.
  const eng = await fetch(`${BASE}/api/profile/engagement`).then((r) => r.json())
  const names = (eng.directives ?? []).map((d: any) => d.name)
  assert.deepEqual(names, ['response-brevity'], 'only the engagement-tagged feedback is returned')
  ok('engagement flag persisted + served')
  console.log(`\n${passed} assertions passed.`); cleanup(); process.exit(0)
} catch (e) { console.error(e); cleanup(); process.exit(1) }
