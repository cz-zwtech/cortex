/**
 * The write-time reflex — M1 deliverable B.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY INTERCEPT AT THE WRITE
 *
 * The ladder and the recall collapse both GUESS sameness from text similarity,
 * which is a genuinely hard inference and the reason §3 exists at all. There is
 * exactly one participant in this pipeline that does not have to guess: the
 * model performing the write already knows whether it is recording the same fact
 * again or a new one. This is the only point where that knowledge exists, so it
 * is the only point where asking is cheaper than inferring.
 *
 * Two duties, and they are ONE mechanism rather than two because they are the
 * same shape — intercept where the deciding information is present:
 *
 *   SECRET DEFLECTION   catch a credential BEFORE it reaches a durable,
 *                       replicated journal, while the writer still has the
 *                       context to rephrase it.
 *   DEDUPE DEFLECTION   show the writer what already exists and hand back the
 *                       GRAPH ID, which is rung 0 — moving the common case off
 *                       the guessing rungs entirely.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS LAYER IS NOT
 *
 * It is LAYER 1, and layer 1 is explicitly NOT guarantee-bearing. It fires only
 * when Cortex is live and the hook is installed, so a session that never read
 * the instructions gets none of it. The ingest scan (layer 2) blocks before the
 * journal append, in our own process with no harness involved, and THAT carries
 * the guarantee.
 *
 * That split is load-bearing rather than decorative. The harness UAT measured a
 * malformed PreToolUse deny being DISCARDED while the tool ran — so a design
 * that had leaned on this reflex as the protection would now have a hole exactly
 * where its guarantee was supposed to be. This layer improves the common case
 * and is allowed to fail; §2 must be correct alone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BOTH OUTPUT CHANNELS ARE CONSUMER-PROVEN, WHICH IS NOT THE SAME AS DOCUMENTED
 *
 *   deny + permissionDecisionReason   the reason becomes the denial message the
 *                                     model receives. Proven behaviourally in
 *                                     UAT run 3: the command was blocked.
 *   additionalContext                 injected as a message to the model.
 *                                     Proven by RECEIPT — V1's ckn-aware.ts
 *                                     emits exactly this shape on PreToolUse and
 *                                     its text arrives in live sessions.
 *
 * Both were checked against a consumer rather than against the schema, because
 * this project has now twice shipped a field that validated and was then
 * silently ignored. Schema acceptance is an emitter-side property.
 *
 * DELIBERATELY UNUSED: `updatedInput`, which would let this rewrite the pending
 * write in place. That is precisely the auto-merge constraint 1 forbids — the
 * reflex informs the writer, it does not edit the writer's text.
 */

import path from 'node:path'

import { underMemoryRoot } from '../../../core/paths.js'
import { splitScratchpad } from './consume.js'
import { LEXICAL_ESTIMATOR, type Estimator } from './reconcile.js'
import { scanForSecrets, type SecretFinding } from '../../../core/secrets.js'
import { slugOf } from './sweep.js'
import type { MemoryStore } from './store.js'

/** The subset of a PreToolUse payload this cares about. */
export type ToolPayload = {
  tool_name?: string
  tool_input?: Record<string, unknown>
  session_id?: string
}

export type ReflexDeps = {
  store: MemoryStore
  scope: string
  /** Roots to test the target path against. Defaults to the configured ones. */
  roots?: string[]
  /** Carries its own floors. Swapping it re-derives nothing here — see §cf8a5cb. */
  estimator?: Estimator
  /** How many existing memories the dedupe pass may compare against. */
  candidateLimit?: number
}

export type ReflexVerdict =
  /** Not a memory write. The overwhelmingly common case, and it must be cheap. */
  | { kind: 'not-mine' }
  /** A credential-shaped value. The only outcome that refuses the write. */
  | { kind: 'deny'; reason: string; findings: SecretFinding[] }
  /** Something the writer should know. Never blocks. */
  | { kind: 'inform'; text: string; matched: string[] }
  /** In scope, nothing to say. Distinct from `not-mine`, and tested separately. */
  | { kind: 'silent' }
  /**
   * In scope, and the graph has nothing to compare against.
   *
   * DISTINCT FROM `silent`, AND THE DISTINCTION IS THE POINT. Today nothing
   * drives ingest, so the graph on a fresh install is permanently empty and the
   * dedupe pass finds nothing on every call — forever, while REPORTING SUCCESS.
   * That is worse than an unbuilt feature: when ingest eventually lands, nobody
   * re-tests dedupe, because dedupe "has been working" the whole time.
   *
   * Same rule as seed provenance one layer up — a system finding nothing because
   * there IS nothing and a system finding nothing because it is broken must not
   * produce the same output.
   */
  | { kind: 'no-corpus'; scope: string }

/**
 * Compared against a WINDOW, not the corpus.
 *
 * A hook runs inside a budget measured in seconds and this pass is O(n) in
 * memories. 200 is a starting point rather than a measured one, and it is small
 * enough that the window is routinely full — which is why a full window is
 * REPORTED rather than absorbed. See `scopeNote`.
 */
export const DEFAULT_CANDIDATE_LIMIT = 200

/** Tools that write file content. Anything else cannot carry a memory. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * The text this tool call is about to put on disk.
 *
 * Only the NEW text. An Edit's `old_string` is already written — scanning it
 * would deny a write whose whole purpose is removing the thing being flagged,
 * which is the most hostile possible false positive.
 */
export const pendingText = (payload: ToolPayload): string => {
  const input = payload.tool_input
  if (!input) return ''
  const parts: string[] = []

  if (typeof input.content === 'string') parts.push(input.content)
  if (typeof input.new_string === 'string') parts.push(input.new_string)
  if (typeof input.new_source === 'string') parts.push(input.new_source)

  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      const s = (e as Record<string, unknown>)?.new_string
      if (typeof s === 'string') parts.push(s)
    }
  }

  return parts.join('\n')
}

const targetPath = (payload: ToolPayload): string => {
  const p = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path
  return typeof p === 'string' ? p : ''
}

/**
 * Decide what to do about a pending write.
 *
 * Ordering is deliberate: SECRETS FIRST. A dedupe hint about content we are
 * refusing to write is noise, and — more importantly — the aggregate response
 * type is a union, so a subscriber gets one channel per event and the refusal is
 * the one that must not be displaced.
 */
export const reflex = (payload: ToolPayload, deps: ReflexDeps): ReflexVerdict => {
  if (!payload.tool_name || !WRITE_TOOLS.has(payload.tool_name)) return { kind: 'not-mine' }

  const file = targetPath(payload)
  if (!file || !underMemoryRoot(file, deps.roots)) return { kind: 'not-mine' }

  const text = pendingText(payload)
  if (!text.trim()) return { kind: 'silent' }

  // ── secret deflection ─────────────────────────────────────────────────────
  const findings = scanForSecrets(text)
  if (findings.length) return { kind: 'deny', reason: denyReason(file, findings), findings }

  // ── dedupe deflection ─────────────────────────────────────────────────────
  return dedupe(text, deps)
}

/**
 * The refusal text the model receives.
 *
 * NEVER carries the matched value. A message that quotes the credential in order
 * to complain about it has published it to the transcript, which is durable and
 * replicated — the same leak one layer over, and the exact defect `SecretFinding`
 * was shaped to prevent by holding a hint instead of the text.
 */
const denyReason = (file: string, findings: SecretFinding[]): string => {
  const lines = findings
    .slice(0, 5)
    .map((f) => `  line ${f.line}: ${f.hint}`)
    .join('\n')
  const more = findings.length > 5 ? `\n  …and ${findings.length - 5} more` : ''

  return (
    `Cortex: this write into ${path.basename(file)} carries ${findings.length} ` +
    `credential-shaped value(s), and memories are appended to a durable, replicated ` +
    `journal that content cannot be taken back out of.\n${lines}${more}\n\n` +
    `Rewrite without the value — name the secret and where it lives (OpenBao path, ` +
    `env var name) rather than quoting it. Naming a key is fine; this matches VALUES, ` +
    `not names. If it is genuinely not a secret, write it and the ingest scan will ` +
    `hold it for release rather than dropping it.`
  )
}

/**
 * Look for what already exists, and say so without ever deciding for the writer.
 *
 * TWO SIGNALS, IN CONFIDENCE ORDER:
 *
 *   SLUG      an exact frontmatter `name:` hit in the same scope. High
 *             precision, needs no similarity judgement, and is the signal the
 *             ladder itself reconciles on.
 *   SIMILARITY a near-duplicate over the recent window. Improves for free when
 *             the estimator does, since the floors travel with it.
 *
 * BIAS TO SPLIT governs everything below. `cannot judge` says NOTHING rather
 * than guessing: a wrong split is visible and repairable, a wrong merge is
 * invisible and permanent, so silence is the safe failure and it is the default.
 */
const dedupe = (text: string, deps: ReflexDeps): ReflexVerdict => {
  const est = deps.estimator ?? LEXICAL_ESTIMATOR
  const limit = deps.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT

  // A file may hold several memories; each is reconciled separately, so each is
  // checked separately. Falling back to the whole text keeps a plain write that
  // carries no frontmatter from being skipped silently.
  const blocks = splitScratchpad(text)
  const units = blocks.length ? blocks : [{ raw: text, body: text, hash: '' }]

  const candidates = deps.store.recent(deps.scope, limit)

  // An empty comparison set is not "no duplicates found" — it is "there was
  // nothing to look in". Reported rather than absorbed.
  if (!candidates.length && !deps.store.count()) return { kind: 'no-corpus', scope: deps.scope }

  const hits = new Map<string, string>()

  for (const unit of units) {
    const slug = slugOf(unit.raw)
    if (slug) {
      for (const m of deps.store.bySlug(deps.scope, slug)) {
        hits.set(m.id, `same slug "${slug}"`)
      }
    }

    for (const m of candidates) {
      if (hits.has(m.id)) continue
      const sim = est.compare(unit.body, m.content)
      // null is CANNOT JUDGE and it is not "not similar" — the distinction this
      // module has paid for repeatedly. Unjudgeable means silent.
      if (sim === null || sim < est.nearDuplicateFloor) continue
      hits.set(m.id, `near-duplicate under ${est.name}`)
    }
  }

  if (!hits.size) return { kind: 'silent' }

  const matched = [...hits.keys()]
  const listed = [...hits.entries()]
    .slice(0, 5)
    .map(([id, why]) => `  ${id} — ${why}`)
    .join('\n')
  const more = hits.size > 5 ? `\n  …and ${hits.size - 5} more` : ''

  return {
    kind: 'inform',
    matched,
    text:
      `## Cortex — this may already be recorded\n\n` +
      `${hits.size} existing memor${hits.size === 1 ? 'y' : 'ies'} in scope "${deps.scope}" ` +
      `look like this write:\n${listed}${more}\n\n` +
      `If it is the SAME fact, put the id in the frontmatter as \`id:\` so it updates ` +
      `that memory instead of creating a near-duplicate. If it is genuinely different — ` +
      `including if it CONTRADICTS one of the above — write it as-is; keeping both is ` +
      `correct and the reflex does not decide this.` +
      scopeNote(candidates.length, limit, est),
  }
}

/**
 * Report the coverage this pass did NOT have.
 *
 * A full window means the comparison set was truncated, and to a reader "no
 * duplicates found" and "no duplicates found in the 200 most recent" are the
 * same sentence with very different meanings. Any mechanism that can silently
 * reduce its own scope has to report the reduction, or its silence gets read as
 * a clean result.
 *
 * The provisional note is the same obligation about a different axis: these
 * floors were chosen, not measured, and saying so at the point of use is what
 * stops them being cited later as though the harness had derived them.
 */
const scopeNote = (found: number, limit: number, est: Estimator): string => {
  const parts: string[] = []
  if (found >= limit) {
    parts.push(
      `compared against the ${limit} most recent memories only — older ones were not checked`,
    )
  }
  if (est.provisional) parts.push(`${est.name} thresholds are provisional`)
  return parts.length ? `\n\n_(${parts.join('; ')}.)_` : ''
}

/**
 * The verdict as a subscriber response.
 *
 * Kept separate from `reflex` so the decision is testable without the harness
 * shape, and so the harness shape is a pure translation with nothing to get
 * wrong twice.
 */
export const toResponse = (
  v: ReflexVerdict,
): { additionalContext: string } | { decision: 'deny'; reason: string } | undefined => {
  if (v.kind === 'deny') return { decision: 'deny', reason: v.reason }
  if (v.kind === 'inform') return { additionalContext: v.text }
  // `no-corpus` deliberately contributes NO context: telling the model about our
  // empty graph on every write would spend another module's injection budget on
  // our own incompleteness. It is reported to the operator instead — see
  // on-pre-tool-use.ts — which is who can act on it.
  return undefined
}
