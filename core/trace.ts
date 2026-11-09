/**
 * The hook trace — durable evidence that a lifecycle event actually reached us.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, STATED PLAINLY BECAUSE IT WAS A REAL GAP
 *
 * The dispatcher exited 0 and wrote nothing. With zero modules installed —
 * which is the naked-scaffold case core explicitly claims to support — a hook
 * that FIRED and a hook that NEVER RAN produced byte-identical evidence.
 *
 * That is worse than an unmade assertion. It is an UNMAKEABLE one: the UAT plan
 * said the harness surface would be proven, and six of seven events could not
 * have been proven by any script, in any environment, because nothing recorded
 * them. A test plan asserting something unmeasurable reads as coverage right up
 * until someone goes looking for the evidence and finds there is none.
 *
 * Measured, not hypothetical: a real UAT run proved exactly one event (`Stop`,
 * which the harness happens to summarise in the transcript) out of seven fired.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT IS A FIRST-CLASS FEATURE, NOT A TEST AFFORDANCE
 *
 * On by default in a normal install. An observability mechanism that only
 * exists under test is itself unobservable in production — the same defect one
 * level up, and we would deserve it. The first question anyone debugging a
 * community install will ask is "are the hooks running at all", and this is the
 * file that answers it.
 *
 * Opt out with CORTEX_TRACE=off. Deliberately opt-OUT rather than opt-in: a
 * default-off diagnostic is absent exactly when the incident happens.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT RECORDS THE INVOCATION, NOT THE WORK
 *
 * A trace entry means "the harness invoked us for this event". It says nothing
 * about whether a module did anything, and it is written even when NO module is
 * installed and no subscriber ran — which is the whole point, because that is
 * precisely the case that was invisible.
 */

import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from './paths.js'

export type TraceEntry = {
  event: string
  /** Wall clock, so a human can line it up against their session. */
  at: string
  /** Subscribers actually invoked. Zero is a legitimate, informative value. */
  subscribers: number
  durationMs: number
  /** Modules started at the time of the call — the naked-scaffold tell. */
  modules: number
  /**
   * The harness-supplied session id, from the hook payload on stdin.
   *
   * THIS IS WHAT MAKES THE TRACE NON-SELF-CERTIFYING, and it exists because the
   * obvious objection is correct: a dispatcher that writes its own trace proves
   * only that the dispatcher ran, not that the HARNESS ran it. I proved that
   * objection myself by firing all seven events from a shell — the entries were
   * indistinguishable from a real session's.
   *
   * A session id is not something the dispatcher can invent. The harness mints
   * it, and it names a transcript file (`projects/<cwd>/<session>.jsonl`) that
   * Cortex never writes. So an entry carrying a session id that matches a
   * transcript on disk is corroborated by an artifact from the other side of
   * the boundary; an entry with no session id was invoked by something that is
   * not the harness, and says so.
   */
  session?: string
  /** Per-invocation nonce, echoed to the harness, so trace and transcript can be joined. */
  nonce?: string
  /** `tool_name` from a real PreToolUse / PostToolUse payload: provenance the dispatcher cannot invent. */
  tool?: string
  /** Subscriber failures, by module. Empty is the normal case. */
  failures?: string[]
}

export const traceFile = (): string => path.join(stateDir(), 'hook-trace.ndjson')

/** Keep the file bounded. A diagnostic that fills a disk is a liability. */
const MAX_BYTES = 512 * 1024

export const traceEnabled = (): boolean =>
  (process.env.CORTEX_TRACE ?? '').toLowerCase() !== 'off'

/**
 * Append one entry. NEVER throws.
 *
 * A trace failure must not take down a lifecycle event: the dispatcher's
 * standing rule is that nothing here can break the user's session, and a
 * diagnostic that can crash the thing it observes is worse than no diagnostic.
 */
export const trace = (entry: TraceEntry): void => {
  if (!traceEnabled()) return
  try {
    const file = traceFile()

    // existsSync BEFORE mkdirSync, and not as an optimisation. `mkdirSync` can
    // BLOCK on a pathological path — measured: it hangs indefinitely under
    // /proc in this container. The dispatcher's rule is that nothing here may
    // break the user's session, and a hook that HANGS is worse than one that
    // throws: it stalls the session until the harness timeout instead of
    // failing fast. "Never throws" was not a strong enough guarantee.
    if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), { recursive: true })

    // Truncate-and-restart rather than rotate: this is a rolling window for
    // debugging, not an audit log, and a second file would imply a durability
    // promise it does not make. The journal is where durability lives.
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.truncateSync(file, 0)
    } catch {
      /* not there yet */
    }

    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8')
  } catch {
    /* never break the session over a diagnostic */
  }
}

/** Read the trace back, newest last. Used by `status` and by the UAT. */
export const readTrace = (): TraceEntry[] => {
  try {
    return fs
      .readFileSync(traceFile(), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as TraceEntry]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/** Which lifecycle events have been seen at least once, and when last. */
export const traceSummary = (): Record<string, { count: number; last: string }> => {
  const out: Record<string, { count: number; last: string }> = {}
  for (const e of readTrace()) {
    const cur = out[e.event]
    out[e.event] = { count: (cur?.count ?? 0) + 1, last: e.at }
  }
  return out
}
