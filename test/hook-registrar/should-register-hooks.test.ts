#!/usr/bin/env tsx
/**
 * #68 shouldRegisterHooks — gate hookRegistrar (ensureStopHook) to a no-op on an
 * ephemeral/test boot, so a server spawned from a worktree (every bus integration
 * test) stops repointing the real ~/.claude hooks + ~/.config/ckn/home onto it.
 *
 * Pure predicate (matches the planUpdate/meshLive/resumeDecision/supersedeScan
 * pure-core pattern): register hooks UNLESS CKN_FORBID_DEFAULT_DB (already the
 * ephemeral-boot, real-user-state-off-limits sentinel — same one db.ts guards on)
 * OR CKN_NO_HOOK_REGISTER (the explicit single-purpose hatch) is set. Truthiness
 * matches the existing db.ts guard exactly: `process.env.CKN_FORBID_DEFAULT_DB`
 * used as a plain boolean — any non-empty value (including '0') counts as set,
 * an empty/absent value does not.
 */
import assert from 'node:assert/strict'

const { shouldRegisterHooks } = await import('../../server/hookRegistrar.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

assert.equal(shouldRegisterHooks({}), true)
ok('real boot (neither flag) → register')

assert.equal(shouldRegisterHooks({ CKN_FORBID_DEFAULT_DB: '1' }), false)
ok('CKN_FORBID_DEFAULT_DB set → skip (ephemeral/test sentinel)')

assert.equal(shouldRegisterHooks({ CKN_NO_HOOK_REGISTER: '1' }), false)
ok('CKN_NO_HOOK_REGISTER set → skip (explicit hatch)')

assert.equal(shouldRegisterHooks({ CKN_FORBID_DEFAULT_DB: '1', CKN_NO_HOOK_REGISTER: '1' }), false)
ok('both set → skip')

assert.equal(shouldRegisterHooks({ CKN_FORBID_DEFAULT_DB: '' }), true)
assert.equal(shouldRegisterHooks({ CKN_NO_HOOK_REGISTER: '' }), true)
ok('empty-string flag → NOT set → register (matches db.ts truthiness)')

assert.equal(shouldRegisterHooks({ CKN_FORBID_DEFAULT_DB: '0' }), false)
ok("non-empty '0' → set → skip (exact db.ts truthiness, not a numeric parse)")

assert.equal(shouldRegisterHooks({ SOME_OTHER: '1' }), true)
ok('unrelated env → register')

console.log(`\n${passed} assertions passed.`)
process.exit(0)
