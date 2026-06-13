#!/usr/bin/env tsx
/** ckn-engagement renders engagement feedback into a CLAUDE.md managed block (file-fallback path). */
import assert from 'node:assert/strict'
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-engcli-'))
const memDir = path.join(home, '.claude', 'memory'); fs.mkdirSync(memDir, { recursive: true })
const claudeMd = path.join(home, '.claude', 'CLAUDE.md')
fs.writeFileSync(claudeMd, '# CLAUDE.md\n\nHand-written rules I keep.\n')
fs.writeFileSync(path.join(memDir, 'response-brevity.md'),
  '---\nname: response-brevity\ndescription: Concise, no sycophancy; brief-first; options with pros/cons\ntype: feedback\nengagement: true\n---\n')
fs.writeFileSync(path.join(memDir, 'plan-first.md'),
  '---\nname: plan-first\ndescription: Plan before any significant change\ntype: feedback\nengagement: true\n---\n')
fs.writeFileSync(path.join(memDir, 'untagged.md'),
  '---\nname: untagged\ndescription: not an engagement directive\ntype: feedback\n---\n')

// Point the CLI at a dead server so it uses the file-fallback path; isolate home via CKN_HOME.
const baseEnv = { ...process.env, CKN_HOME: home, CKN_SERVER_URL: 'http://127.0.0.1:59999' }
const run = (args: string[], extra: Record<string,string> = {}) => new Promise<{code:number;out:string}>((resolve) => {
  const cp = spawn(path.join(repoRoot, 'node_modules/.bin/tsx'), [path.join(repoRoot, 'bin/ckn-engagement.ts'), ...args],
    { cwd: repoRoot, env: { ...baseEnv, ...extra } })
  let out = ''; cp.stdout.on('data', d => out += d); cp.stderr.on('data', d => out += d)
  cp.on('close', c => resolve({ code: c ?? -1, out }))
})
let passed = 0; const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }
try {
  await run(['sync'])
  let md = fs.readFileSync(claudeMd, 'utf8')
  assert.match(md, /Hand-written rules I keep\./, 'original content preserved')
  assert.match(md, /cortex:managed:engagement/, 'block written')
  assert.match(md, /Concise, no sycophancy/, 'directive 1 present')
  assert.match(md, /Plan before any significant change/, 'directive 2 present')
  assert.ok(!md.includes('not an engagement directive'), 'untagged feedback excluded')
  // directives sorted by name → plan-first before response-brevity
  assert.ok(md.indexOf('Plan before') < md.indexOf('Concise, no'), 'sorted by memory name')
  ok('sync renders engagement directives into the block')

  const before = md
  await run(['sync'])
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), before, 'idempotent — no rewrite when unchanged')
  ok('idempotent / write-only-on-change')

  await run(['--remove'])
  md = fs.readFileSync(claudeMd, 'utf8')
  assert.ok(!md.includes('cortex:managed:engagement'), 'block removed')
  assert.match(md, /Hand-written rules I keep\./, 'original preserved after remove')
  ok('--remove strips the block')

  fs.writeFileSync(claudeMd, '# CLAUDE.md\n\nbase\n')
  await run(['sync'], { CKN_MANAGED_CLAUDEMD: 'off' })
  assert.ok(!fs.readFileSync(claudeMd, 'utf8').includes('cortex:managed'), 'kill-switch disables writing')
  ok('CKN_MANAGED_CLAUDEMD=off is a no-op')

  // --show is read-only: prints the sorted, header-rendered directives without touching CLAUDE.md.
  fs.writeFileSync(claudeMd, '# CLAUDE.md\n\nshow-base\n')
  const showRes = await run(['--show'])
  assert.equal(showRes.code, 0, '--show exits 0')
  assert.match(showRes.out, /How to engage me/, '--show renders the header')
  assert.match(showRes.out, /Concise, no sycophancy/, '--show prints directive 1')
  assert.match(showRes.out, /Plan before any significant change/, '--show prints directive 2')
  assert.ok(!showRes.out.includes('not an engagement directive'), '--show excludes untagged feedback')
  assert.ok(showRes.out.indexOf('Plan before') < showRes.out.indexOf('Concise, no'), '--show sorted by memory name')
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), '# CLAUDE.md\n\nshow-base\n', '--show does not write CLAUDE.md')
  ok('--show prints directives read-only (no write)')

  // --remove honors the kill-switch: with CKN_MANAGED_CLAUDEMD=off it must NOT modify CLAUDE.md
  // (the invariant is "off ⇒ no writes at all", removal included).
  fs.writeFileSync(claudeMd, '# CLAUDE.md\n\nrm-base\n')
  await run(['sync'])
  const withBlock = fs.readFileSync(claudeMd, 'utf8')
  assert.match(withBlock, /cortex:managed:engagement/, 'precondition: block present before remove')
  await run(['--remove'], { CKN_MANAGED_CLAUDEMD: 'off' })
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), withBlock, '--remove is a no-op when the kill-switch is off')
  ok('--remove honors CKN_MANAGED_CLAUDEMD=off')

  console.log(`\n${passed} assertions passed.`)
  fs.rmSync(home, { recursive: true, force: true }); process.exit(0)
} catch (e) { console.error(e); fs.rmSync(home, { recursive: true, force: true }); process.exit(1) }
