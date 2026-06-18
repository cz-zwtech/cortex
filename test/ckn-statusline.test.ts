#!/usr/bin/env tsx
/**
 * ckn-statusline — the opt-in installer for the Cortex statusline dots. Focus on
 * the adaptive routing + ship-none discipline: detect an existing statusLine
 * (snippet-only, never touch it); no statusLine + explicit consent → scaffold a
 * minimal dots-only script under ~/.config/ckn AND wire the key, preserving other
 * settings; no consent / non-TTY → pointer only, write NOTHING.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { detectStatusLine } = await import('../bin/ckn-statusline.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const tmpHome = (): string => mkdtempSync(path.join(os.tmpdir(), 'cknsl-'))
const run = (args: string[], home: string): string =>
  execFileSync('node_modules/.bin/tsx', ['bin/ckn-statusline.ts', ...args], {
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
    encoding: 'utf8',
  })

// ── detectStatusLine (pure) ──
{
  assert.equal(detectStatusLine('{"statusLine":{"type":"command","command":"x"}}'), true, 'configured')
  assert.equal(detectStatusLine('{}'), false, 'no key')
  assert.equal(detectStatusLine(''), false, 'empty file')
  assert.equal(detectStatusLine('not json'), false, 'invalid json')
  assert.equal(detectStatusLine('{"statusLine":{}}'), false, 'empty object = not configured')
  ok('detectStatusLine: true only for a real statusLine')
}

// ── scaffold path: no statusLine + consent → write + wire, preserve other keys ──
{
  const home = tmpHome()
  mkdirSync(path.join(home, '.claude'), { recursive: true })
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'x', env: { A: '1' } }))
  run(['--dots', 'bus,mesh', '--yes'], home)
  const sl = path.join(home, '.config', 'ckn', 'statusline.sh')
  assert.ok(existsSync(sl), 'scaffold written to ~/.config/ckn/statusline.sh')
  assert.match(readFileSync(sl, 'utf8'), /mesh_seg|bus_watcher_armed/, 'scaffold has the dot functions')
  assert.ok((statSync(sl).mode & 0o111) !== 0, 'scaffold is executable')
  const settings = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
  assert.ok(settings.statusLine?.command?.includes('statusline.sh'), 'statusLine wired to the scaffold')
  assert.equal(settings.model, 'x', 'preserves top-level keys')
  assert.equal(settings.env.A, '1', 'preserves nested keys')
  rmSync(home, { recursive: true, force: true })
  ok('scaffold path: writes + wires on consent, preserves settings')
}

// ── snippet path: existing statusLine → snippet only, NEVER clobber (even with --yes) ──
{
  const home = tmpHome()
  mkdirSync(path.join(home, '.claude'), { recursive: true })
  const orig = JSON.stringify({ statusLine: { type: 'command', command: 'mine.sh' } })
  writeFileSync(path.join(home, '.claude', 'settings.json'), orig)
  const out = run(['--dots', 'bus', '--yes'], home)
  assert.match(out, /bus_watcher_armed/, 'prints the snippet to paste')
  assert.ok(!existsSync(path.join(home, '.config', 'ckn', 'statusline.sh')), 'no scaffold when statusLine exists')
  assert.equal(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), orig, 'existing settings untouched')
  rmSync(home, { recursive: true, force: true })
  ok('snippet path: existing statusLine → snippet only, never clobber')
}

// ── ship-none default: no statusLine, no consent, non-TTY → pointer only, no write ──
{
  const home = tmpHome()
  const out = run(['--dots', 'bus,mesh'], home)
  assert.ok(!existsSync(path.join(home, '.config', 'ckn', 'statusline.sh')), 'ship-none: nothing written without consent')
  assert.ok(!existsSync(path.join(home, '.claude', 'settings.json')), 'ship-none: no settings.json created')
  assert.match(out, /ckn-statusline/, 'prints a pointer to enable it later')
  rmSync(home, { recursive: true, force: true })
  ok('ship-none default: no consent → pointer only, no write')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
