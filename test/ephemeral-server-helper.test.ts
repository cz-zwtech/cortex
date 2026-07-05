#!/usr/bin/env tsx
/**
 * FR #154 slice 5 — the central ephemeral server harness. Any test that spawns a
 * real server/index.ts should use spawnEphemeralServer, which ALWAYS sets
 * CKN_FORBID_DEFAULT_DB + CKN_NO_HOOK_REGISTER and isolates HOME/DB/config, so a
 * spawned test server can NEVER register real user state (the exact hole that let
 * the engagement-sync boot hijack the home pointer). Proves: the server comes up,
 * and NOTHING is written under the temp HOME.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnEphemeralServer } from './_ephemeralServer.js'

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-ephem-test-'))
const srv = await spawnEphemeralServer({ port: 3098, home })
try {
  // server responds
  const r = await fetch(`${srv.baseUrl}/api/home`)
  assert.ok(r.ok, 'ephemeral server is up on /api/home')
  ok('spawnEphemeralServer boots a reachable server')

  // registration suppressed: no real user state under the temp HOME
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false, 'no settings.json written')
  assert.equal(fs.existsSync(path.join(home, '.config', 'ckn', 'home')), false, 'no home cache written')
  assert.equal(fs.existsSync(path.join(home, '.claude', 'commands')), false, 'no commands dir written')
  ok('ephemeral boot writes NO real user state under HOME (cannot hijack)')
} finally {
  srv.stop()
  fs.rmSync(home, { recursive: true, force: true })
}

console.log(`\nOK ephemeral-server-helper.test.ts — ${passed} checks passed`)
process.exit(0)
