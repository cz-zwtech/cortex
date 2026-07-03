import assert from 'node:assert/strict'

// #139 A — ckn-reboot must NOT silently downgrade a running full-mode node.
// leanEnv forced CKN_PRIVATE_MIND/CKN_EMBEDDINGS to off whenever they were
// undefined in the reboot shell, so a node running full mode rebooted degraded
// (and ckn-mind-sync inherited the off verdict, halting federation). The fix:
// read the running server's actual booted env and carry it forward; lean only
// when explicitly asked. These pure helpers hold the decision.
const { parseEnviron, resolveRebootEnv } = await import('../bin/rebootEnv.core.js')

// ── parseEnviron: /proc/<pid>/environ is NUL-separated KEY=VAL ────────────────
assert.deepEqual(parseEnviron('A=1\0B=2\0'), { A: '1', B: '2' })
assert.deepEqual(parseEnviron('CKN_EMBEDDINGS=local\0CKN_PRIVATE_MIND=on\0X=\0'), {
  CKN_EMBEDDINGS: 'local',
  CKN_PRIVATE_MIND: 'on',
  X: '',
})
assert.deepEqual(parseEnviron(''), {})
// a value may itself contain '=' (split on the FIRST only)
assert.deepEqual(parseEnviron('K=a=b\0'), { K: 'a=b' })

// ── resolveRebootEnv ─────────────────────────────────────────────────────────
// running full, nothing overridden -> carry full forward, no warning (THE fix)
{
  const r = resolveRebootEnv({ explicit: {}, lean: false, live: { privateMind: 'on', embeddings: 'local' } })
  assert.equal(r.privateMind, 'on')
  assert.equal(r.embeddings, 'local')
  assert.deepEqual(r.warnings, [])
}

// running lean -> preserve lean
{
  const r = resolveRebootEnv({ explicit: {}, lean: false, live: { privateMind: 'off', embeddings: 'off' } })
  assert.equal(r.privateMind, 'off')
  assert.equal(r.embeddings, 'off')
  assert.deepEqual(r.warnings, [])
}

// explicit caller override wins over the running mode (no warn — deliberate)
{
  const r = resolveRebootEnv({ explicit: { embeddings: 'off' }, lean: false, live: { privateMind: 'on', embeddings: 'local' } })
  assert.equal(r.privateMind, 'on') // carried
  assert.equal(r.embeddings, 'off') // explicit wins
  assert.deepEqual(r.warnings, [])
}

// --lean forces off even on a running-full node — explicit intent, no warn
{
  const r = resolveRebootEnv({ explicit: {}, lean: true, live: { privateMind: 'on', embeddings: 'local' } })
  assert.equal(r.privateMind, 'off')
  assert.equal(r.embeddings, 'off')
  assert.deepEqual(r.warnings, [])
}

// live unknown (couldn't read /proc), nothing overridden -> leave BOTH unset
// (server default, NOT a forced off) and warn loudly for each
{
  const r = resolveRebootEnv({ explicit: {}, lean: false, live: {} })
  assert.equal(r.privateMind, undefined)
  assert.equal(r.embeddings, undefined)
  assert.equal(r.warnings.length, 2)
}

// partial live (private-mind known, embeddings not) -> carry the known one,
// warn only for the unknown one
{
  const r = resolveRebootEnv({ explicit: {}, lean: false, live: { privateMind: 'on' } })
  assert.equal(r.privateMind, 'on')
  assert.equal(r.embeddings, undefined)
  assert.equal(r.warnings.length, 1)
}

console.log('reboot-env: parseEnviron + resolveRebootEnv OK')
process.exit(0)
