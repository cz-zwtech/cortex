#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import {
  AVAILABILITY,
  isAssigned,
  deriveMandate,
  assignmentCoherence,
  type CoherenceInput,
} from '../../server/bus/mandate.js'

// ── isAssigned ───────────────────────────────────────────────────────────────
assert.equal(isAssigned('assigned'), true)
assert.equal(isAssigned('available'), false)
assert.equal(isAssigned(''), false)
assert.equal(AVAILABILITY.ASSIGNED, 'assigned')

// ── deriveMandate: override wins; else first non-empty line; clamp; empty → '' ──
assert.equal(deriveMandate('do the thing', 'reviewer: cortex'), 'reviewer: cortex', 'override wins')
assert.equal(deriveMandate('  spaced override  ', '  reviewer: x  '), 'reviewer: x', 'override trimmed')
assert.equal(deriveMandate('\n\n  first real line\nsecond'), 'first real line', 'first non-empty line, trimmed')
assert.equal(deriveMandate(''), '', 'empty body → empty mandate')
assert.equal(deriveMandate('   \n  \n'), '', 'whitespace-only body → empty')
const long = 'x'.repeat(200)
const derived = deriveMandate(long)
assert.equal(derived.length, 120, 'long line clamped to 120')
assert.ok(derived.endsWith('...'), 'clamp marks truncation')
assert.equal(deriveMandate(long, ''), derived, 'empty override falls through to derivation')

// ── assignmentCoherence ────────────────────────────────────────────────────
const base: CoherenceInput = {
  isAssignment: true,
  senderId: 'meta_coord',
  senderMandate: 'orchestrator: EPIC-12',
  trust: 'local',
  ownAvailability: '',
  ownAssignedBy: '',
}

// guardrail 3 — an unverified source is NEVER actionable, regardless of state.
for (const isAssignment of [true, false]) {
  const v = assignmentCoherence({ ...base, isAssignment, trust: 'unverified' })
  assert.equal(v.action, 'defer-untrusted', 'unverified → defer-untrusted (never widened)')
  assert.equal(v.conflictingAssignment, false)
  assert.equal(v.offAssigner, false)
}

// assignment to an available / unassigned session → accept + self-stamp.
assert.equal(assignmentCoherence({ ...base, ownAvailability: 'available' }).action, 'accept')
assert.equal(assignmentCoherence({ ...base, ownAvailability: '' }).action, 'accept')
assert.equal(assignmentCoherence({ ...base, trust: 'mesh', ownAvailability: 'available' }).action, 'accept', 'mesh source accepts too')

// re-assignment from MY OWN assigner while assigned → accept (a coordinator may re-task its own session).
assert.equal(
  assignmentCoherence({ ...base, ownAvailability: 'assigned', ownAssignedBy: 'meta_coord' }).action,
  'accept',
  'same-assigner re-task is fine',
)

// (b) STATE CHECK — a SECOND assignment from a DIFFERENT coordinator while assigned → surface, not silent re-task.
const conflict = assignmentCoherence({
  ...base,
  ownAvailability: 'assigned',
  ownAssignedBy: 'meta_other',
})
assert.equal(conflict.action, 'surface', 'conflicting reassignment surfaces')
assert.equal(conflict.conflictingAssignment, true)
assert.equal(conflict.offAssigner, false)

// (c) ANCHOR CHECK — a non-assignment directive from someone OTHER than my assigner → surface.
const offAssigner = assignmentCoherence({
  ...base,
  isAssignment: false,
  senderId: 'meta_stranger',
  ownAvailability: 'assigned',
  ownAssignedBy: 'meta_coord',
})
assert.equal(offAssigner.action, 'surface', 'off-assigner directive surfaces')
assert.equal(offAssigner.offAssigner, true)
assert.equal(offAssigner.conflictingAssignment, false)

// non-assignment directive FROM my assigner → accept (coherent with anchor).
assert.equal(
  assignmentCoherence({
    ...base,
    isAssignment: false,
    senderId: 'meta_coord',
    ownAvailability: 'assigned',
    ownAssignedBy: 'meta_coord',
  }).action,
  'accept',
  'directive from my assigner is coherent',
)

// non-assignment directive while I hold NO assignment → accept (nothing to contradict).
assert.equal(
  assignmentCoherence({ ...base, isAssignment: false, senderId: 'meta_whoever', ownAvailability: 'available', ownAssignedBy: '' }).action,
  'accept',
  'unassigned session has no anchor to violate',
)

console.log('mandate.test.ts: all assertions passed')
