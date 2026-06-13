#!/usr/bin/env tsx
/**
 * shouldRebind transcript-awareness (Part 3 name-anchoring). A SessionStart
 * rebinds (signs off) a prior live session that shares its name+cwd — UNLESS the
 * prior is transcript-backed and the incoming is not. A bootstrap PHANTOM
 * (no transcript) must NEVER steal a name from / sign off a real, transcript-
 * backed session (the exact harm of the 2026-06-11 churn: a phantom rebind
 * signed off the real 411f5f18 row).
 */
import assert from 'node:assert/strict'
import { shouldRebind } from '../../server/bus/identity.ts'

const base = {
  incoming: { friendlyName: 'cortex-dev', cwd: '/path/to/repos', sessionId: 'NEW' },
  prior: { friendlyName: 'cortex-dev', cwd: '/path/to/repos', sessionId: 'OLD', status: 'live' },
}

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. transcript-less incoming (phantom) must NOT rebind a transcript-backed prior
{
  const r = shouldRebind(
    { ...base.incoming, hasTranscript: false },
    { ...base.prior, hasTranscript: true },
  )
  assert.equal(r, false, 'a phantom incoming never supersedes a real transcript-backed prior')
  ok('transcript-less incoming cannot sign off a transcript-backed prior')
}

// ── 2. transcript-backed incoming DOES rebind a transcript-less prior (real resume)
{
  const r = shouldRebind(
    { ...base.incoming, hasTranscript: true },
    { ...base.prior, hasTranscript: false },
  )
  assert.equal(r, true, 'a real incoming reclaims the name from a transcript-less prior')
  ok('transcript-backed incoming supersedes a transcript-less prior')
}

// ── 3. both transcript-backed → normal rebind (name+cwd+live match)
{
  const r = shouldRebind(
    { ...base.incoming, hasTranscript: true },
    { ...base.prior, hasTranscript: true },
  )
  assert.equal(r, true, 'two real rows: name+cwd+live match → rebind as before')
  ok('both transcript-backed: normal rebind')
}

// ── 4. back-compat: no transcript flags supplied → original name+cwd+live behavior
{
  assert.equal(shouldRebind(base.incoming, base.prior), true, 'unflagged rebind still works')
  assert.equal(
    shouldRebind({ ...base.incoming, friendlyName: 'other' }, base.prior),
    false,
    'name mismatch still blocks rebind',
  )
  ok('back-compat preserved when transcript flags are omitted')
}

console.log(`\nOK should-rebind-transcript.test.ts — ${passed} assertions passed`)
