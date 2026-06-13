/**
 * Pure helpers for mandate-in-presence (Item 1) — no I/O, unit-testable
 * standalone (test/bus/mandate.test.ts).
 *
 * Model (round-table 2026-06-09, Corey-ratified): a session's *mandate* is
 * RUNTIME-coordinator-assigned, not birth-declared. A session opts into the
 * orchestration pool (`available`) via a slash command; a coordinator dispatches
 * a task with humanProvenance; the receiver SELF-STAMPS its mandate + provenance
 * anchor on pickup (`assigned`) and clears back to `available` when done. It is
 * declarative honor-context, never a capability grant.
 *
 * GUARDRAILS these helpers must never break:
 *   (1) mandate is NEVER an input to classifyTrust — trust is decided upstream
 *       and PASSED IN here; this module only *reads* it.
 *   (2) mandate/anchor are NEVER routing/dedup/addressing keys — nothing here
 *       resolves a recipient or dedups delivery.
 *   (3) the coherence verdict only NARROWS (it can downgrade `accept` → `surface`
 *       / `defer-untrusted`); it never upgrades an untrusted source to actionable.
 */

export const AVAILABILITY = {
  /** Not in the orchestration pool (the default — a session opts in explicitly). */
  NONE: '',
  /** Opted into the pool via /cortex-available; a coordinator may assign it. */
  AVAILABLE: 'available',
  /** Currently working a coordinator-assigned mandate. */
  ASSIGNED: 'assigned',
} as const

export type Availability = (typeof AVAILABILITY)[keyof typeof AVAILABILITY]

/** True iff the session currently holds an assignment. */
export const isAssigned = (availability: string): boolean => availability === AVAILABILITY.ASSIGNED

/**
 * The mandate text to stamp on pickup. An explicit `override` ("role: scope")
 * wins; otherwise it's derived from the dispatch body (first non-empty line,
 * clamped) — Fable's "derived from the dispatch by default" default. The full
 * dispatch is always recoverable via the anchor (assigned_ref = msg id), so the
 * derived label only needs to be a glanceable summary.
 */
export const deriveMandate = (body: string, override?: string): string => {
  const o = (override ?? '').trim()
  if (o) return o
  const firstLine = String(body ?? '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean) ?? ''
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine
}

export type CoherenceAction = 'accept' | 'surface' | 'defer-untrusted'

export interface CoherenceInput {
  /** Does this dispatch claim to assign work (a self-stamp candidate)? */
  isAssignment: boolean
  /** Sender's durable identity (metaId) — compared against the receiver's anchor. */
  senderId: string
  /** Sender's OWN mandate, surfaced for the peer check (content judgment is the LLM's). */
  senderMandate: string
  /** Source trust, decided UPSTREAM by classifyTrust (guardrail 1: read-only here). */
  trust: 'local' | 'mesh' | 'unverified'
  /** Receiver's current availability: '' | 'available' | 'assigned'. */
  ownAvailability: string
  /** Receiver's anchor: the metaId that assigned its current mandate (if assigned). */
  ownAssignedBy: string
}

export interface CoherenceVerdict {
  action: CoherenceAction
  /** (b) a 2nd assignment from a DIFFERENT assigner while already assigned. */
  conflictingAssignment: boolean
  /** (c) a non-assignment directive from someone OTHER than my current assigner. */
  offAssigner: boolean
  reasons: string[]
}

/**
 * The three-check antibody, as a pure decision the awareness render presents
 * (assist-not-enforce — this NEVER blocks; it tells the receiver when to hesitate
 * + surface instead of act). The content-level peer check (a) — "is this directive
 * consistent with the sender's mandate?" — is a semantic judgment left to the LLM,
 * so we carry `senderMandate` through for the render rather than deciding it here.
 *
 *   - Untrusted source → `defer-untrusted` (the existing surface-never-execute rule;
 *     the antibody defers to trust and never widens it — guardrail 3).
 *   - (b) State check: a conflicting reassignment of an already-assigned session →
 *     `surface` (don't silently re-task — the subagent "no re-task mid-run" discipline).
 *   - (c) Anchor check: a directive from someone other than my assigner while I'm
 *     assigned → `surface` (off-assigner work is visible by construction).
 *   - Otherwise → `accept`.
 */
export const assignmentCoherence = (i: CoherenceInput): CoherenceVerdict => {
  const reasons: string[] = []

  if (i.trust === 'unverified') {
    return {
      action: 'defer-untrusted',
      conflictingAssignment: false,
      offAssigner: false,
      reasons: ['source is unverified — surface, never execute (trust gate, unchanged)'],
    }
  }

  const assignedNow = isAssigned(i.ownAvailability)
  const fromMyAssigner = !!i.ownAssignedBy && i.senderId === i.ownAssignedBy

  if (i.isAssignment) {
    if (assignedNow && !fromMyAssigner) {
      reasons.push(
        'already assigned by a different coordinator — a second assignment is a coordination bug or hijack; hesitate + surface, do not silently re-task',
      )
      return { action: 'surface', conflictingAssignment: true, offAssigner: false, reasons }
    }
    reasons.push(
      assignedNow ? 're-assignment from my own assigner' : 'available — accept and self-stamp',
    )
    return { action: 'accept', conflictingAssignment: false, offAssigner: false, reasons }
  }

  // Non-assignment directive.
  if (assignedNow && i.ownAssignedBy && !fromMyAssigner) {
    reasons.push(
      'directive from someone other than my current assigner while I hold an assignment — surface (off-assigner work contradicts my anchor)',
    )
    return { action: 'surface', conflictingAssignment: false, offAssigner: true, reasons }
  }
  reasons.push('coherent with my current anchor (from my assigner, or I hold no assignment)')
  return { action: 'accept', conflictingAssignment: false, offAssigner: false, reasons }
}
