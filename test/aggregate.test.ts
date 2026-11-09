import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateContext,
  aggregateDecision,
  aggregateTitle,
  buildHookResponse,
  canSetTitle,
  type Contribution,
} from '../core/aggregate.js'

const ctxOf = (module: string, additionalContext: string): Contribution => ({
  module,
  response: { additionalContext },
})

test('context contributions merge in subscriber order', () => {
  const out = aggregateContext([ctxOf('a', 'first'), ctxOf('b', 'second')])
  assert.equal(out.additionalContext, 'first\n\nsecond')
  assert.deepEqual(out.included, ['a', 'b'])
})

test('subscribers that return nothing are ignored, not errors', () => {
  const out = aggregateContext([
    { module: 'silent', response: undefined },
    ctxOf('a', 'text'),
    { module: 'void', response: null },
  ])
  assert.equal(out.additionalContext, 'text')
  assert.deepEqual(out.included, ['a'])
})

test('empty and whitespace-only contributions do not create blank blocks', () => {
  const out = aggregateContext([ctxOf('a', '   '), ctxOf('b', 'real')])
  assert.equal(out.additionalContext, 'real')
})

test('BUDGET: an over-budget contribution is dropped WHOLE and REPORTED', () => {
  // Dropping whole blocks rather than cutting mid-text is deliberate: half a
  // memory reads as complete and the consumer cannot tell it was cut.
  const out = aggregateContext([ctxOf('small', 'abc'), ctxOf('huge', 'x'.repeat(100))], 50)

  assert.equal(out.additionalContext, 'abc')
  assert.deepEqual(out.included, ['small'])
  assert.equal(out.truncated.length, 1, 'a dropped contribution must never be silent')
  assert.equal(out.truncated[0]?.module, 'huge')
  assert.equal(out.truncated[0]?.bytes, 100, 'report HOW BIG it was, not just that it went')
  assert.ok(out.truncated[0]!.remainingBytes < 100, 'and how much room was left')
})

test('BUDGET: one greedy module cannot crowd out the rest by arriving first', () => {
  // The failure this budget exists to prevent — but note what it does NOT do:
  // a greedy FIRST module still wins its own budget. Ordering is the module's
  // declared priority, and core does not re-rank by size.
  const out = aggregateContext([ctxOf('greedy', 'x'.repeat(40)), ctxOf('polite', 'y')], 50)
  assert.deepEqual(out.included, ['greedy', 'polite'])
  assert.deepEqual(out.truncated, [])
})

test('BUDGET: byte-counted, not character-counted', () => {
  // A multi-byte character must count as its real size, or the budget silently
  // overruns on non-ASCII content.
  const multi = '€'.repeat(10) // 3 bytes each = 30
  const out = aggregateContext([ctxOf('a', multi)], 20)
  assert.equal(out.truncated[0]?.module, 'a')
})

test('DECISION: no decisions at all means allow', () => {
  // Silence is not an objection. Requiring every module to vote would make
  // saying nothing dangerous.
  const out = aggregateDecision([ctxOf('a', 'text')])
  assert.equal(out.decision, 'allow')
  assert.deepEqual(out.allDeniers, [])
})

test('DECISION: an explicit allow is still allow', () => {
  const out = aggregateDecision([{ module: 'a', response: { decision: 'allow' } }])
  assert.equal(out.decision, 'allow')
})

test('DECISION: DENY WINS over allow — the votes are not symmetric', () => {
  // A denier asserts a reason not to proceed; an allower merely declines to
  // object. Majority voting would let two indifferent modules overrule one that
  // found a real problem.
  const out = aggregateDecision([
    { module: 'permissive-1', response: { decision: 'allow' } },
    { module: 'guard', response: { decision: 'deny', reason: 'writes outside the repo' } },
    { module: 'permissive-2', response: { decision: 'allow' } },
  ])

  assert.equal(out.decision, 'deny')
  assert.equal(out.deniedBy, 'guard')
  assert.equal(out.reason, 'writes outside the repo')
})

test('DECISION: every denier is reported, not just the first', () => {
  const out = aggregateDecision([
    { module: 'g1', response: { decision: 'deny', reason: 'reason one' } },
    { module: 'g2', response: { decision: 'deny', reason: 'a different reason' } },
  ])
  assert.equal(out.deniedBy, 'g1')
  assert.deepEqual(out.allDeniers, ['g1', 'g2'], 'a second objection is information, not noise')
})

test('a module can contribute context AND another can deny in the same event', () => {
  const out = buildHookResponse(
    [
      ctxOf('memory', 'here is what I know'),
      { module: 'guard', response: { decision: 'deny', reason: 'nope' } },
    ],
    'PreToolUse',
  )
  const specific = out?.hookSpecificOutput as Record<string, unknown>
  assert.equal(specific.additionalContext, 'here is what I know')
  assert.equal(specific.permissionDecision, 'deny')
  assert.equal(specific.permissionDecisionReason, 'nope')
})

test('PreToolUse refuses via permissionDecision, NEVER via `decision`', () => {
  // Measured against a real harness: `{decision:"deny"}` fails schema
  // validation, the verdict is DISCARDED, and the tool RUNS. A malformed
  // refusal fails OPEN, which makes the shape a security property rather than
  // a formatting preference — both of M3's write-time protections are
  // PreToolUse denies.
  const out = buildHookResponse([{ module: 'guard', response: { decision: 'deny' } }], 'PreToolUse')
  assert.equal(out?.decision, undefined, 'the deprecated field is not used')
  const specific = out?.hookSpecificOutput as Record<string, unknown>
  assert.equal(specific.hookEventName, 'PreToolUse')
  assert.equal(specific.permissionDecision, 'deny')
})

test('Stop and PostToolUse refuse via `decision: block`, not `deny`', () => {
  // "deny" is not a valid value for this field at all — that was the other
  // half of the same defect.
  for (const event of ['Stop', 'PostToolUse', 'UserPromptSubmit']) {
    const out = buildHookResponse([{ module: 'g', response: { decision: 'deny' } }], event)
    assert.equal(out?.decision, 'block', event)
  }
})

test('context rides hookSpecificOutput, where the harness documents it', () => {
  // Top-level additionalContext was accepted on SessionStart and SILENTLY
  // IGNORED on UserPromptSubmit — a corroboration route that failed without
  // failing, found by joining the trace against the transcript.
  const out = buildHookResponse([ctxOf('memory', 'recalled')], 'UserPromptSubmit')
  const specific = out?.hookSpecificOutput as Record<string, unknown>
  assert.equal(specific.hookEventName, 'UserPromptSubmit')
  assert.equal(specific.additionalContext, 'recalled')
})

test('nothing to say produces NULL, so the dispatcher writes silence', () => {
  // An empty JSON object is not the same as silence, and the harness should
  // see silence.
  assert.equal(buildHookResponse([], 'SessionStart'), null)
  assert.equal(buildHookResponse([{ module: 'a', response: undefined }], 'SessionStart'), null)
})

test('a deny with no reason still explains itself', () => {
  const out = buildHookResponse([{ module: 'guard', response: { decision: 'deny' } }], 'Stop')
  assert.match(String(out?.reason), /guard/, 'the user must learn WHICH module blocked them')
})

test('ATTRIBUTION: a failing subscriber must not shift later results onto it', async () => {
  // Regression guard for a bug caught by reading the wiring back: the bus
  // returned a bare results array, but a failing subscriber contributes no
  // entry — so positional alignment against the subscriber list silently
  // attributed every later result to the wrong module. The values were all
  // real, just labelled wrong, which is the kind of defect nothing surfaces.
  const { EventBus } = await import('../core/events.js')
  const bus = new EventBus()

  bus.subscribe('E', 'first-fails', () => {
    throw new Error('boom')
  }, 10)
  bus.subscribe('E', 'second-ok', () => ({ additionalContext: 'from second' }), 20)

  const r = await bus.publish('E')

  assert.equal(r.results.length, 1)
  assert.equal(r.results[0]?.module, 'second-ok', 'the surviving result belongs to who produced it')

  const out = aggregateContext(
    r.results.map((x) => ({ module: x.module, response: x.value as never })),
  )
  assert.deepEqual(out.included, ['second-ok'], 'and it is attributed correctly downstream')
})

test('PRESSURE REPORTING: core names the evicted module and the numbers', () => {
  // Core cannot fix a redundant contribution — knowing what two blocks of text
  // MEAN is the module's domain. What it can do is make the pressure visible,
  // so the evicted author is not left guessing and the human learns the
  // injection was incomplete.
  const out = aggregateContext(
    [ctxOf('redundant', 'x'.repeat(45)), ctxOf('evicted', 'y'.repeat(30))],
    50,
  )

  assert.deepEqual(out.included, ['redundant'])
  assert.equal(out.truncated.length, 1)
  assert.equal(out.truncated[0]?.module, 'evicted')
  assert.equal(out.truncated[0]?.bytes, 30, 'how big the dropped contribution was')
  assert.equal(out.truncated[0]?.remainingBytes, 5, 'and how little room was left for it')
})

// ── session title ────────────────────────────────────────────────────────────


test('a title contribution reaches hookSpecificOutput on the two events that can carry it', () => {
  const contributions: Contribution[] = [{ module: 'comms', response: { sessionTitle: 'acme-dev2' } }]
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const out = buildHookResponse(contributions, event) as any
    assert.equal(out.hookSpecificOutput.sessionTitle, 'acme-dev2', event)
    assert.equal(out.hookSpecificOutput.hookEventName, event)
  }
})

test('a title is never emitted on an event that cannot carry one', () => {
  const contributions: Contribution[] = [{ module: 'comms', response: { sessionTitle: 'acme-dev2' } }]
  assert.equal(canSetTitle('PreToolUse'), false)
  assert.equal(buildHookResponse(contributions, 'PreToolUse'), null)
})

test('title and context from one module both survive aggregation', () => {
  const contributions: Contribution[] = [
    { module: 'comms', response: { sessionTitle: 'acme-dev2', additionalContext: 'you are acme-dev2' } },
  ]
  const out = buildHookResponse(contributions, 'SessionStart') as any
  assert.equal(out.hookSpecificOutput.sessionTitle, 'acme-dev2')
  assert.equal(out.hookSpecificOutput.additionalContext, 'you are acme-dev2')
})

test('first title in subscriber order wins and a disagreeing module is reported, not dropped silently', () => {
  const t = aggregateTitle([
    { module: 'a', response: { sessionTitle: 'one' } },
    { module: 'b', response: { sessionTitle: 'one' } },
    { module: 'c', response: { sessionTitle: 'two' } },
    { module: 'd', response: { additionalContext: 'no title here' } },
  ])
  assert.equal(t.sessionTitle, 'one')
  assert.equal(t.setBy, 'a')
  assert.deepEqual(t.overruled, ['c'])
})

test('a title-only contribution adds no context', () => {
  const out = aggregateContext([{ module: 'comms', response: { sessionTitle: 'x' } }])
  assert.equal(out.additionalContext, '')
  assert.deepEqual(out.included, [])
})
