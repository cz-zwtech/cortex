/**
 * Response aggregation — the return direction of the dispatcher.
 *
 * This existed as a gap for an embarrassing reason: the dispatcher was designed
 * for INVOCATION and never for RETURN, when the return is what harness hooks are
 * FOR. One core hook per event means core must merge N subscriber outputs into
 * ONE response, and there are two genuinely different kinds of output that
 * cannot be merged the same way.
 *
 *   CONTEXT   — additive. SessionStart-class subscribers contribute text to
 *               inject. More contributors means more context, up to a budget.
 *   DECISION  — conflicting. PreToolUse-class subscribers return allow/deny.
 *               Two subscribers can disagree, and someone must arbitrate.
 *
 * Merging those with one rule would be wrong in both directions: concatenating
 * decisions is meaningless, and arbitrating context discards contributions that
 * were never in conflict.
 */

/** A subscriber's contribution. Anything else is ignored, not an error. */
export type SubscriberResponse =
  | { additionalContext: string; sessionTitle?: string }
  | { decision: 'allow' | 'deny'; reason?: string }
  | { sessionTitle: string; additionalContext?: string }
  | void
  | undefined
  | null

export type Contribution = { module: string; response: SubscriberResponse }

/**
 * A contribution that did not fit.
 *
 * Reported with SIZES, not just a name, because the module author needs to know
 * whether they were 40 bytes over or 4000 — and because the most common cause
 * is another module's internal redundancy, which is invisible without numbers.
 */
export type Truncation = {
  module: string
  /** Size of the contribution that was dropped. */
  bytes: number
  /** Budget still unspent when it was offered. */
  remainingBytes: number
}

export type AggregatedContext = {
  additionalContext: string
  /** Modules whose text was included, in injection order. */
  included: string[]
  /**
   * Contributions dropped because the budget was exhausted. NEVER silent.
   *
   * Core allocates budget; it cannot curate content. When a module's
   * contribution is internally redundant it spends several slots saying one
   * thing and crowds others out — core cannot detect or fix that, because
   * knowing what two blocks of text MEAN is the module's domain, not the
   * scaffold's. What core can do is report the pressure, so an author learns
   * their contribution is evicting others and a human learns their injection
   * was incomplete.
   */
  truncated: Truncation[]
  bytes: number
}

export type AggregatedDecision = {
  decision: 'allow' | 'deny'
  /** The module that produced a deny, when denied. */
  deniedBy?: string
  reason?: string
  /** Every module that voted deny — a second denier is still worth knowing. */
  allDeniers: string[]
}

/**
 * Default injection budget, bytes.
 *
 * A cap has to exist: subscribers contribute into a context window, and an
 * unbounded merge lets one verbose module crowd out every other and degrade the
 * session it was meant to help. The number is a starting point, not a derived
 * value — labelled as such rather than presented as measured, per the standing
 * rule about unvalidated constants.
 */
export const DEFAULT_CONTEXT_BUDGET_BYTES = 16_000

/**
 * Merge context contributions in subscriber order.
 *
 * ORDER IS SUBSCRIBER ORDER, not "most relevant first" — core cannot judge
 * relevance across modules and should not pretend to. Modules declare priority
 * in their manifest; that is the ordering signal, and it is theirs.
 *
 * Truncation drops WHOLE contributions rather than cutting mid-text. A half a
 * memory is worse than no memory: it reads as complete and the consumer cannot
 * tell it was cut.
 */
export const aggregateContext = (
  contributions: Contribution[],
  budgetBytes: number = DEFAULT_CONTEXT_BUDGET_BYTES,
): AggregatedContext => {
  const parts: string[] = []
  const included: string[] = []
  const truncated: Truncation[] = []
  let bytes = 0

  for (const { module, response } of contributions) {
    const text = response && 'additionalContext' in response ? response.additionalContext : undefined
    if (typeof text !== 'string' || !text.trim()) continue

    const size = Buffer.byteLength(text, 'utf-8')
    // +2 for the separator between blocks, once there is something to separate.
    const withSeparator = parts.length === 0 ? size : size + 2

    if (bytes + withSeparator > budgetBytes) {
      truncated.push({ module, bytes: size, remainingBytes: Math.max(0, budgetBytes - bytes) })
      continue
    }

    parts.push(text)
    included.push(module)
    bytes += withSeparator
  }

  return { additionalContext: parts.join('\n\n'), included, truncated, bytes }
}

/**
 * Arbitrate decisions.
 *
 * DENY WINS. A subscriber that denies has asserted a reason not to proceed;
 * a subscriber that allows has merely declined to object. Those are not
 * symmetric claims, so majority voting would be wrong — it would let two
 * indifferent modules overrule one that found a real problem.
 *
 * No decision at all is ALLOW. A module that returns nothing has not objected,
 * and requiring every module to vote on every tool call would make silence
 * dangerous.
 */
export const aggregateDecision = (contributions: Contribution[]): AggregatedDecision => {
  const deniers: { module: string; reason?: string }[] = []

  for (const { module, response } of contributions) {
    if (!response || !('decision' in response)) continue
    if (response.decision === 'deny') deniers.push({ module, reason: response.reason })
  }

  if (deniers.length === 0) return { decision: 'allow', allDeniers: [] }

  // Report the first denier as the cause, but list them all: a second module
  // objecting for a different reason is information the user loses if we only
  // surface one.
  const first = deniers[0]!
  return {
    decision: 'deny',
    deniedBy: first.module,
    reason: first.reason,
    allDeniers: deniers.map((d) => d.module),
  }
}

/**
 * The harness-facing payload for one event.
 *
 * Emits only what is present: an event with no context contributions and no
 * decisions produces `null`, and the dispatcher writes nothing at all. An empty
 * JSON object is not the same as silence, and the harness should see silence.
 */
/**
 * Events whose refusal is expressed as `decision: "block"`.
 *
 * PreToolUse is deliberately ABSENT: its refusal goes through
 * `hookSpecificOutput.permissionDecision`, and the legacy `decision` field is
 * documented as deprecated for it.
 */
const BLOCK_EVENTS = new Set(['PostToolUse', 'Stop', 'UserPromptSubmit'])

/**
 * The harness-facing payload for one event.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SHAPE IS PER-EVENT, AND GETTING IT WRONG FAILS OPEN
 *
 * An earlier revision emitted `{ decision: "deny", reason }` for every event.
 * Measured against a real harness: `deny` is not a valid `decision` value at
 * all, PreToolUse does not use that field, and the harness responded with
 * "Hook JSON output validation failed" — then DISCARDED THE VERDICT AND RAN THE
 * TOOL. A malformed refusal did not fail the operation; it silently permitted
 * it.
 *
 * That is why this function is event-aware rather than uniform. The schema,
 * from the harness's own documentation:
 *
 *   context     hookSpecificOutput: { hookEventName, additionalContext }
 *   PreToolUse  hookSpecificOutput: { hookEventName, permissionDecision,
 *                                     permissionDecisionReason }
 *   block       decision: "block" + reason   (PostToolUse | Stop |
 *                                             UserPromptSubmit)
 *
 * Emitting the wrong one is not a formatting error. It is a security-relevant
 * failure, because both of M3's write-time protections are PreToolUse denies.
 */
export const buildHookResponse = (
  contributions: Contribution[],
  event: string,
  budgetBytes?: number,
): Record<string, unknown> | null => {
  const ctx = aggregateContext(contributions, budgetBytes)
  const dec = aggregateDecision(contributions)

  const out: Record<string, unknown> = {}
  const specific: Record<string, unknown> = { hookEventName: event }

  if (ctx.additionalContext) specific.additionalContext = ctx.additionalContext

  const title = aggregateTitle(contributions)
  if (title.sessionTitle && TITLE_EVENTS.has(event)) specific.sessionTitle = title.sessionTitle

  if (dec.decision === 'deny') {
    const reason = dec.reason ?? `blocked by ${dec.deniedBy}`
    if (event === 'PreToolUse') {
      specific.permissionDecision = 'deny'
      specific.permissionDecisionReason = reason
    } else if (BLOCK_EVENTS.has(event)) {
      out.decision = 'block'
      out.reason = reason
    }
    // Any other event cannot express a refusal at all. Rather than emit
    // something the harness will discard — which is what fails open — the
    // dispatcher reports it loudly on stderr; see bin/cortex-hook.ts.
  }

  if (Object.keys(specific).length > 1) out.hookSpecificOutput = specific
  return Object.keys(out).length ? out : null
}

/**
 * Events whose hook output can name the session.
 *
 * Claude Code accepts `sessionTitle` from SessionStart and UserPromptSubmit
 * only, with the same effect as `/rename`. The title is the one piece of
 * per-session state the harness persists AND hands back to hooks on resume,
 * which is why the comms module carries member identity in it.
 */
const TITLE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit'])

export const canSetTitle = (event: string): boolean => TITLE_EVENTS.has(event)

export type AggregatedTitle = {
  sessionTitle?: string
  /** The module whose title was used. */
  setBy?: string
  /**
   * Other modules that asked for a DIFFERENT title. First in subscriber order
   * wins; the losers are reported rather than silently overruled, because two
   * modules disagreeing about what a session is called is a real conflict.
   */
  overruled: string[]
}

/** First non-empty title in subscriber order wins. */
export const aggregateTitle = (contributions: Contribution[]): AggregatedTitle => {
  let sessionTitle: string | undefined
  let setBy: string | undefined
  const overruled: string[] = []
  for (const { module, response } of contributions) {
    const t = response && 'sessionTitle' in response ? response.sessionTitle : undefined
    if (typeof t !== 'string' || !t.trim()) continue
    if (sessionTitle === undefined) {
      sessionTitle = t.trim()
      setBy = module
    } else if (t.trim() !== sessionTitle) {
      overruled.push(module)
    }
  }
  return { sessionTitle, setBy, overruled }
}

/** True when this event can carry a refusal the harness will honour. */
export const canRefuse = (event: string): boolean =>
  event === 'PreToolUse' || BLOCK_EVENTS.has(event)
