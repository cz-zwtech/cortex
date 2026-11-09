/**
 * Liveness proof for the harness boundary.
 *
 * THE STANDARD EVERY ASSERTION HERE ANSWERS: could this evidence exist if the
 * thing did not happen THIS RUN? The threat model is self-deception rather than
 * fraud — nobody is forging anything, the risk is evidence that exists equally
 * in both worlds. Byte-identical-either-way fails the test, and so does any
 * artifact that survived from a previous run.
 *
 * That standard is why a nonce exists at all. A trace entry saying "SessionStart
 * fired" is indistinguishable from one written last week, or one written by a
 * human running the dispatcher from a shell — both of which happened during
 * development, and the second contaminated a real run's evidence before anyone
 * noticed.
 */

import { randomBytes } from 'node:crypto'

/**
 * A per-invocation nonce.
 *
 * The dispatcher echoes it to the harness on context-injecting events; the
 * harness records what it injected in its own transcript; the trace records the
 * same value. The assertion is the JOIN of the two — neither side alone, since
 * each is a single reporter about itself.
 */
export const mintNonce = (): string => `ckn-${randomBytes(9).toString('base64url')}`

/**
 * The line carried back to the harness.
 *
 * Deliberately self-describing: a human reading their own transcript should be
 * able to tell what this is and that it is harmless, without going looking.
 */
export const nonceLine = (event: string, nonce: string): string =>
  `<cortex-liveness event="${event}" nonce="${nonce}" />`

/**
 * OFF BY DEFAULT. The liveness echo is a UAT instrument, not a runtime feature.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PAYLOAD BEING HARMLESS IS A PROPERTY OF TODAY'S CONTENT. THE PATH BEING
 * OPEN IS A PROPERTY OF THE ARCHITECTURE.
 *
 * Shipped as it was, every SessionStart and UserPromptSubmit injected this tag
 * into the session's context unconditionally — and worse, it did so by appending
 * to `hookSpecificOutput.additionalContext` AFTER aggregation, bypassing the
 * budget and truncation reporting every module contribution is subject to. Core
 * had a private, unbudgeted, always-on write channel into the model's context.
 *
 * The random nonce was proof that path was live and unguarded.
 *
 * Two changes, and the second matters more than this flag: the echo is now
 * opt-in, AND it is emitted as an ordinary CONTRIBUTION so it flows through the
 * same aggregation as everything else. There is no privileged injection path
 * left to gate — which is what stops the payload question from mattering.
 */
export const livenessEnabled = (): boolean =>
  (process.env.CORTEX_LIVENESS ?? '').toLowerCase() === 'on'

/**
 * The canary a UAT script asks for so PreToolUse can be proven BEHAVIOURALLY.
 *
 * A denied tool call is recorded by the harness along with its reason, and that
 * evidence cannot exist unless the hook ran and its verdict was honoured — the
 * strongest form available, because it proves the hook CHANGED WHAT HAPPENED
 * rather than merely that something was written somewhere.
 *
 * A literal no real command would contain, so the deny needs no flag. Gating it
 * behind one would make the deny path test-only, which is exactly the class of
 * defect this file exists to close.
 */
export const CANARY_TOOL_MARKER = 'cortex-uat-canary'
