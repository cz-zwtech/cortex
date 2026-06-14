#!/usr/bin/env tsx
/**
 * PostCompact resume-state — the pure decision core. resumeDecision() restores the MANDATE
 * but never trusts a pre-compact trigger: a present+parseable mode is authoritative, a
 * waiting-on predicate is re-evaluated against ground truth, and anything missing /
 * unparseable / unknowable (incl. a self-id resolution miss) falls to AMBIGUOUS = safe-hold.
 * parseWaitingOn()/evalThreadPredicate()/evalBusPredicate() are the pure pieces the
 * server-side evaluator composes against the live graph.
 */
import assert from 'node:assert/strict'

const { resumeDecision, parseWaitingOn, evalThreadPredicate, evalBusPredicate } = await import(
  '../server/graph/resumeState.js'
)

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// ── resumeDecision (pure 3-state) ─────────────────────────────────────────────
assert.equal(resumeDecision({ selfIdResolved: false, mode: 'working', predEval: null }), 'ambiguous')
ok('self-id resolution miss → ambiguous (prereq, safe)')
assert.equal(resumeDecision({ selfIdResolved: true, mode: null, predEval: null }), 'ambiguous')
ok('no mode on the claim → ambiguous (safe)')
assert.equal(resumeDecision({ selfIdResolved: true, mode: '   ', predEval: null }), 'ambiguous')
ok('blank mode → ambiguous (safe)')
assert.equal(resumeDecision({ selfIdResolved: true, mode: 'working', predEval: null }), 'resumable')
ok('mode=working → resumable')
assert.equal(resumeDecision({ selfIdResolved: true, mode: 'quiesced', predEval: null }), 'resumable')
ok('mode=quiesced → resumable')
assert.equal(resumeDecision({ selfIdResolved: true, mode: 'waiting-on:bus=m_9', predEval: 'satisfied' }), 'resumable')
ok('waiting-on + predicate SATISFIED → resumable (trigger re-confirmed)')
assert.equal(resumeDecision({ selfIdResolved: true, mode: 'waiting-on:bus=m_9', predEval: 'unsatisfied' }), 'held')
ok('waiting-on + predicate UNSATISFIED → held')
assert.equal(resumeDecision({ selfIdResolved: true, mode: 'waiting-on:bus=m_9', predEval: 'unknowable' }), 'ambiguous')
ok('waiting-on + predicate UNKNOWABLE → ambiguous (safe)')
assert.equal(resumeDecision({ selfIdResolved: true, mode: 'garbage-mode', predEval: null }), 'ambiguous')
ok('unparseable mode → ambiguous (safe)')

// ── parseWaitingOn (pure) ─────────────────────────────────────────────────────
assert.deepEqual(parseWaitingOn('waiting-on:thread=t_1:status=approved'), {
  kind: 'thread',
  threadId: 't_1',
  status: 'approved',
})
ok('parse waiting-on:thread=<id>:status=<x>')
// real thread ids carry the colon-bearing 'thread:' prefix — the id capture must be greedy
// (status is colonless), or waiting-on:thread never resolves (→ unknowable → ambiguous).
assert.deepEqual(parseWaitingOn('waiting-on:thread=thread:cortex-memory-build:status=done'), {
  kind: 'thread',
  threadId: 'thread:cortex-memory-build',
  status: 'done',
})
ok('parse a colon-bearing thread:-prefixed id (greedy id, non-colon status)')
assert.deepEqual(parseWaitingOn('waiting-on:bus=m_42'), { kind: 'bus', msgId: 'm_42' })
ok('parse waiting-on:bus=<msgid>')
assert.equal(parseWaitingOn('working'), null)
ok('non-waiting mode → null (not a predicate)')
assert.equal(parseWaitingOn('waiting-on:nonsense'), null)
ok('malformed waiting-on → null (unparseable → caller treats as unknowable)')

// ── evalThreadPredicate / evalBusPredicate (pure) ─────────────────────────────
assert.equal(evalThreadPredicate({ status: 'approved' }, { found: true, status: 'approved' }), 'satisfied')
ok('thread status matches → satisfied')
assert.equal(evalThreadPredicate({ status: 'approved' }, { found: true, status: 'open' }), 'unsatisfied')
ok('thread status differs → unsatisfied')
assert.equal(evalThreadPredicate({ status: 'approved' }, { found: false }), 'unknowable')
ok('thread not found → unknowable')
assert.equal(evalBusPredicate(true), 'satisfied')
ok('bus reply exists → satisfied')
assert.equal(evalBusPredicate(false), 'unsatisfied')
ok('bus reply absent → unsatisfied')

console.log(`\n${passed} assertions passed.`)
process.exit(0)
