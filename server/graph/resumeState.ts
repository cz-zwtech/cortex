/**
 * PostCompact resume-state — the pure decision core (#89).
 *
 * Spine: a resumed session RESTORES its MANDATE (the durable claim survives compact in the
 * graph) but never TRUSTS a pre-compact TRIGGER — a waiting-on condition is re-evaluated
 * against ground truth, and anything we can't currently confirm falls to AMBIGUOUS (safe).
 *
 * The mode lives on the live claim (working | quiesced | waiting-on:<predicate>). v0 has two
 * GRAPH-checkable predicates — thread state and a bus reply — deliberately nothing whose
 * truth lives outside the graph (those would only ever be 'unknowable' → AMBIGUOUS anyway).
 *
 * Bounded limitation (documented, accepted): a session that FORGETS to mark waiting-on is
 * read as `working` → resumable. That's safe because the hook only INJECTS a head; the model
 * re-assesses before acting, and the standing no-auto-exec-next_step rule still holds.
 */
export type ResumeVerdict = 'resumable' | 'held' | 'ambiguous'
export type PredEval = 'satisfied' | 'unsatisfied' | 'unknowable'

export type Predicate =
  | { kind: 'thread'; threadId: string; status: string }
  | { kind: 'bus'; msgId: string }

/**
 * Decide the resume verdict. `predEval` is the caller's ground-truth evaluation of a
 * waiting-on predicate (null for non-waiting modes; pass 'unknowable' for an unparseable
 * waiting-on so it falls to AMBIGUOUS).
 */
export function resumeDecision(input: {
  selfIdResolved: boolean
  mode: string | null
  predEval: PredEval | null
}): ResumeVerdict {
  if (!input.selfIdResolved) return 'ambiguous' // can't trust a claim we can't attribute (prereq)
  const m = (input.mode ?? '').trim()
  if (!m) return 'ambiguous' // no mode → safe-hold
  if (m === 'working' || m === 'quiesced') return 'resumable'
  if (m.startsWith('waiting-on:')) {
    if (input.predEval === 'satisfied') return 'resumable'
    if (input.predEval === 'unsatisfied') return 'held'
    return 'ambiguous' // unknowable / unparseable
  }
  return 'ambiguous' // unparseable mode → safe-hold
}

/** Parse a waiting-on mode into a checkable predicate; null if not waiting-on or malformed. */
export function parseWaitingOn(mode: string): Predicate | null {
  const m = (mode ?? '').trim()
  if (!m.startsWith('waiting-on:')) return null
  const spec = m.slice('waiting-on:'.length)
  // Thread ids carry the colon-bearing 'thread:' prefix, so the id capture is GREEDY and
  // the status is the colonless tail (ThreadStatus values never contain ':'). A non-greedy
  // id would stop at the first colon and never match a real thread id.
  const t = /^thread=(.+):status=([^:]+)$/.exec(spec)
  if (t) return { kind: 'thread', threadId: t[1]!, status: t[2]! }
  const b = /^bus=(.+)$/.exec(spec)
  if (b) return { kind: 'bus', msgId: b[1]! }
  return null // malformed waiting-on → caller treats as unknowable
}

/** Ground-truth eval of a thread-state predicate. */
export function evalThreadPredicate(
  pred: { status: string },
  actual: { found: boolean; status?: string },
): PredEval {
  if (!actual.found) return 'unknowable'
  return actual.status === pred.status ? 'satisfied' : 'unsatisfied'
}

/** Ground-truth eval of a bus predicate: satisfied iff the awaited reply has landed. */
export function evalBusPredicate(replyExists: boolean): PredEval {
  return replyExists ? 'satisfied' : 'unsatisfied'
}
