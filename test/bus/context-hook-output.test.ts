#!/usr/bin/env tsx
/**
 * ckn-context fires on BOTH SessionStart and (historically) PostCompact. CC only
 * accepts `hookSpecificOutput.additionalContext` on context-injection events
 * (SessionStart / UserPromptSubmit / PostToolUse, …) — NOT on PostCompact, which is
 * notification-only and REJECTS that shape ("Hook JSON output validation failed").
 * In CC ≥2.1 the /compact re-inject is handled by SessionStart with source="compact",
 * so PostCompact must emit NOTHING rather than an output CC will reject. `renderHookOutput`
 * is the pure gate that enforces this.
 */
import assert from 'node:assert/strict'
import { renderHookOutput } from '../../bin/ckn-context.js'

const MD = '## awareness\n\nsome context'

// ── SessionStart (incl. source="compact") → valid additionalContext JSON ──
const ss = renderHookOutput('SessionStart', MD)
assert.ok(ss, 'SessionStart emits output')
const parsed = JSON.parse(ss!)
assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart', 'echoes the event name')
assert.equal(parsed.hookSpecificOutput.additionalContext, MD, 'carries the markdown verbatim')

// ── other context-injection events are also supported ──
assert.ok(renderHookOutput('UserPromptSubmit', MD), 'UserPromptSubmit supports additionalContext')
assert.ok(renderHookOutput('PostToolUse', MD), 'PostToolUse supports additionalContext')

// ── PostCompact → null (the bug fix: never emit the shape CC rejects) ──
assert.equal(
  renderHookOutput('PostCompact', MD),
  null,
  'PostCompact must NOT emit hookSpecificOutput.additionalContext (CC rejects it; SessionStart source=compact re-injects)',
)

// ── unknown / empty event → null (fail-safe: emit nothing rather than risk a reject) ──
assert.equal(renderHookOutput('Frobnicate', MD), null, 'an unknown event emits nothing')
assert.equal(renderHookOutput('', MD), null, 'an empty event name emits nothing')

console.log('context-hook-output OK')
process.exit(0)
