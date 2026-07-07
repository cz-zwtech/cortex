#!/usr/bin/env tsx
/**
 * FR resume-presence S3b: the registrar writes SAFE prompt-boundary hook timeouts
 * so every node gets the cold-resume budget fix on registration, not a per-node
 * hand-patch. Two guarantees:
 *   1. HOOKS sets UserPromptSubmit + PreToolUse to >= 10s.
 *   2. ensureHook RE-STAMPS a drifted timeout even when the command is unchanged —
 *      previously it returned 'noop' and left an already-installed 3s in place, so
 *      the new default never reached existing installs.
 */
import assert from 'node:assert/strict'
import { ensureHook, buildCommand, HOOKS } from '../../server/hookRegistrar.js'

// 1. The two prompt-boundary hooks carry a >= 10s budget.
const ups = HOOKS.find((h) => h.event === 'UserPromptSubmit')
const pre = HOOKS.find((h) => h.event === 'PreToolUse')
assert.ok(ups && ups.timeout >= 10, 'UserPromptSubmit timeout is >= 10s')
assert.ok(pre && pre.timeout >= 10, 'PreToolUse timeout is >= 10s')

// 2. ensureHook re-stamps a drifted timeout on an otherwise-current install.
const projectRoot = '/opt/cortex'
const spec = {
  event: 'UserPromptSubmit',
  matcher: '',
  scriptName: 'ckn-pause-context.ts',
  marker: 'ckn-pause-context',
  timeout: 10,
}
const command = buildCommand(spec.scriptName, projectRoot)

// Existing install: SAME command (no drift), but the OLD 3s timeout.
const settings: Record<string, any> = {
  hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command, timeout: 3 }] }] },
}
const result = ensureHook(settings, spec, projectRoot)
assert.equal(result, 'updated', 'a timeout drift (3→10) is re-stamped even when the command is unchanged')
const h = settings.hooks.UserPromptSubmit[0].hooks[0]
assert.equal(h.timeout, 10, 'the installed hook timeout is rewritten to the spec value')
assert.equal(h.command, command, 'the command itself is left unchanged')

// No drift → noop (idempotent).
const current: Record<string, any> = {
  hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command, timeout: 10 }] }] },
}
assert.equal(ensureHook(current, spec, projectRoot), 'noop', 'a matching timeout is a noop')

console.log('ensure-hook-timeout OK')
process.exit(0)
