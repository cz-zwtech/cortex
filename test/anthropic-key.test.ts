#!/usr/bin/env tsx
/**
 * Shared OpenBao-aware Anthropic key resolver. Pure (no server, no network for
 * the deterministic cases) — uses shell stand-ins for CKN_API_KEY_CMD so the
 * graceful-degradation contract is provable offline.
 */
import assert from 'node:assert/strict'
import { resolveAnthropicKey } from '../bin/_anthropic-key.js'

const clear = () => {
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.CKN_API_KEY_CMD
}

// 1. neither set → null
clear()
assert.equal(await resolveAnthropicKey(), null, 'no env, no cmd → null')

// 2. direct env var wins
clear()
process.env.ANTHROPIC_API_KEY = 'sk-direct-xyz'
assert.equal(await resolveAnthropicKey(), 'sk-direct-xyz', 'ANTHROPIC_API_KEY in env wins')

// 3. CKN_API_KEY_CMD stdout is used (and trimmed) when env var absent
clear()
process.env.CKN_API_KEY_CMD = 'printf "sk-from-cmd\n"'
assert.equal(await resolveAnthropicKey(), 'sk-from-cmd', 'CKN_API_KEY_CMD stdout used + trimmed')

// 4. graceful: cmd exits non-zero (e.g. bao-run key-not-present, exit 67) → null
clear()
process.env.CKN_API_KEY_CMD = 'exit 67'
assert.equal(await resolveAnthropicKey(), null, 'cmd failure (exit 67) → null, not error')

// 5. graceful: cmd prints empty → null
clear()
process.env.CKN_API_KEY_CMD = 'printf ""'
assert.equal(await resolveAnthropicKey(), null, 'empty stdout → null')

// 6. direct env still wins even if a (would-fail) cmd is also set
clear()
process.env.ANTHROPIC_API_KEY = 'sk-direct-2'
process.env.CKN_API_KEY_CMD = 'exit 1'
assert.equal(await resolveAnthropicKey(), 'sk-direct-2', 'env wins; cmd not consulted')

clear()
console.log('anthropic-key.test.ts: all assertions passed')
