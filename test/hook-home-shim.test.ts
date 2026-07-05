#!/usr/bin/env tsx
/**
 * hookRegistrar relocatable shim. buildCommand emits a $HOME cache-read shim with a
 * derived-literal fallback + exec (stdin passthrough, command-only); ensureHomeEnv
 * upserts CORTEX_HOME_DIR preserving existing env keys; ensureHook adds/rewrites to
 * the shim (upgrades old absolute-path hooks) and repairs the command-only invariant
 * (strips a stray args field). All operate on in-memory settings — no real file I/O.
 */
import assert from 'node:assert/strict'

const { buildCommand, ensureHook, ensureHomeEnv } = await import('../server/hookRegistrar.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const ROOT = '/opt/cortex'
const SPEC = { event: 'Stop', matcher: '', scriptName: 'ckn-sync.ts', marker: 'ckn-sync', timeout: 30 }

// ── buildCommand: the $HOME cache shim ──────────────────────────────────────
{
  const cmd = buildCommand('ckn-sync.ts', ROOT)
  assert.ok(cmd.includes('"$HOME/.config/ckn/home"'), 'reads cache via $HOME')
  assert.ok(!cmd.includes('~/'), 'no tilde form')
  assert.ok(cmd.includes('[ -z "$H" ]') && cmd.includes('H="/opt/cortex"'), 'derived-literal fallback on a missing cache (#154)')
  assert.ok(cmd.includes('WARN') && cmd.includes('>&2'), 'loud stderr warn when falling back (#154)')
  assert.ok(/\bexec\b/.test(cmd), 'exec for stdin passthrough')
  assert.ok(cmd.includes('/bin/ckn-sync.ts'), 'targets the script')
  assert.ok(cmd.includes('/node_modules/.bin/tsx'), 'invokes tsx')
  ok('buildCommand emits $HOME cache shim w/ literal fallback + exec')
}

// ── ensureHomeEnv: upsert preserving existing keys + idempotent ──────────────
{
  const s: any = { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } }
  assert.equal(ensureHomeEnv(s, ROOT), true, 'changed')
  assert.equal(s.env.CORTEX_HOME_DIR, ROOT)
  assert.equal(s.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1', 'telemetry preserved')
  assert.equal(ensureHomeEnv(s, ROOT), false, 'idempotent no-op')
  const s2: any = {}
  ensureHomeEnv(s2, ROOT)
  assert.equal(s2.env.CORTEX_HOME_DIR, ROOT, 'creates env block when absent')
  ok('ensureHomeEnv upserts CORTEX_HOME_DIR preserving env, idempotent')
}

// ── ensureHook: add when absent ─────────────────────────────────────────────
{
  const s: any = {}
  assert.equal(ensureHook(s, SPEC, ROOT), 'added')
  const h = s.hooks.Stop[0].hooks[0]
  assert.ok(h.command.includes('H="/opt/cortex"') && h.command.includes('/bin/ckn-sync.ts'), 'shim command')
  assert.equal(h.args, undefined, 'no args field (command-only)')
  ok('ensureHook adds the shim when absent')
}

// ── ensureHook: upgrade an OLD absolute-path cortex hook → shim ──────────────
{
  const s: any = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [
            { type: 'command', command: '/old/path/node_modules/.bin/tsx /old/path/bin/ckn-sync.ts', timeout: 30 },
          ],
        },
      ],
    },
  }
  assert.equal(ensureHook(s, SPEC, ROOT), 'updated', 'old absolute → updated')
  assert.ok(s.hooks.Stop[0].hooks[0].command.includes('H="/opt/cortex"'), 'rewritten to shim')
  ok('ensureHook upgrades an old absolute-path cortex hook to the shim')
}

// ── ensureHook: current shim present → noop (idempotent) ─────────────────────
{
  const s: any = {}
  ensureHook(s, SPEC, ROOT)
  assert.equal(ensureHook(s, SPEC, ROOT), 'noop', 'idempotent')
  ok('ensureHook is a no-op when the shim already matches')
}

// ── ensureHook: command-only invariant — strips a stray args field ───────────
{
  const s: any = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: buildCommand('ckn-sync.ts', ROOT), args: [], timeout: 30 }],
        },
      ],
    },
  }
  assert.equal(ensureHook(s, SPEC, ROOT), 'updated', 'invariant repair = updated')
  assert.equal(s.hooks.Stop[0].hooks[0].args, undefined, 'args stripped')
  ok('ensureHook repairs an exec-form (args) cortex hook to command-only')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
