/**
 * UserPromptSubmit — query recall. The surface where memory earns its keep.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FIRES ON EVERY PROMPT, WHICH SETS EVERY CONSTRAINT
 *
 * SessionStart happens once and can afford to think. This runs in front of a
 * human on every single turn, so:
 *
 *   - the budget is TIGHT, and exceeding it costs the user latency on a keypress;
 *   - the injection is SMALL, because it competes with the actual conversation
 *     for the same window, every turn, forever;
 *   - and a miss is CHEAP — the next prompt gets another chance — which is what
 *     makes aggressive bounds correct here rather than merely tolerable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PAYLOAD FIELD IS `prompt`, AND THAT WAS VERIFIED, NOT ASSUMED
 *
 * Read from the harness's own payload construction:
 *
 *   hook_event_name:"UserPromptSubmit", prompt: e, …
 *
 * V1's UserPromptSubmit hook never reads the prompt, so there was no consumer to
 * learn it from — and guessing a field name is how a hook silently receives
 * `undefined` and injects nothing forever while looking installed.
 */

import os from 'node:os'

import type { ModuleCtx } from '../../../core/ctx.js'
import { machineId } from '../../../core/machineId.js'
import { applicableConstraints, constraintsShownSince, isShown, loadPrivacy, markConstraintsShown, renderConstraints, scopeOfCwd } from './constraints.js'
import { injectsInto } from './headless.js'
import { renderHits } from './inject.js'
import { recall, type RecallResult } from './recall.js'
import { lexicalSeed } from './seed.js'
import { MemoryStore } from './store.js'
import { appendRecallLog } from './recallLog.js'
import { queryTerms, terms } from './relevance.js'
import { roleSynonyms } from './entities.js'
import { indexSubjects, resolveRoles, type Resolved } from './subjects.js'
import { recordSurfacing, rememberShown, REPEAT_WINDOW_MS, shownRecently } from './surfacing.js'
import { contextWindows, rememberSurfaced, renderWindows, wantsDepth } from './context/depth.js'
import { contextStorePath } from './context/hooks.js'
import { ContextStore } from './context/store.js'
import type { Memory } from './types.js'

/**
 * Depth, when the prompt asks why: the dialogue behind the answer, in a budget
 * of its own (design 4.6). Graded as related now; Stop upgrades what the answer used.
 */
const depthContext = (ctx: ModuleCtx, query: string, hits: Memory[], session: string | undefined): string => {
  if (!wantsDepth(query)) return ''
  let store: ContextStore | undefined
  try {
    store = new ContextStore(contextStorePath(ctx.dataDir))
    const { text, shown } = renderWindows(contextWindows(store, query, hits.map((m) => ({ name: m.name, source: m.source }))))
    if (!shown.length) return ''
    const blocks = shown.flatMap((w) => w.blocks)
    const now = Date.now()
    store.touchHeat(blocks.map((b) => String(b.id)), 'block', 'related', now)
    store.touchHeat(hits.map((m) => m.id), 'memory', 'related', now)
    store.logPull(now, session, query, blocks.map((b) => b.id))
    if (session) rememberSurfaced(ctx.dataDir, session, { at: now, query, blocks: blocks.map((b) => ({ id: b.id, text: b.text })), memories: hits.map((m) => m.id) })
    return text
  } catch (err) {
    ctx.log(`depth recall skipped: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  } finally {
    store?.close()
  }
}

export type PromptPayload = { prompt?: string; session_id?: string; cwd?: string }

/**
 * What the user wrote, without what the harness wrapped around or put in place
 * of it.
 *
 * A background task's completion, a monitor event, a local command's output
 * and a system reminder all arrive as the prompt. Recalling on them matched
 * bus and peer chatter: a turn holding only a monitor event got off-topic
 * excerpts, and a long session can hold many such turns. A slash
 * command's arguments are the user's words and stay.
 */
const HARNESS_BLOCKS = /<(task-notification|system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|bash-input|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g

export const userText = (prompt: string): string =>
  prompt.replace(HARNESS_BLOCKS, ' ').replace(/<\/?command-args>/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Small on purpose: this competes with the conversation on every turn. Sized so
 * PROMPT_K hits of PROMPT_HIT_BYTES each fit: a hit is shortened, never skipped.
 */
export const PROMPT_BUDGET_BYTES = 2_400
export const PROMPT_K = 4
/** Constraints at prompt time: the write-time check (up to five) is where they matter most. */
export const PROMPT_MAX_CONSTRAINTS = 2
/**
 * The least query relevance a prompt-time hit needs. Calibrated on a sample of
 * prompts: off-topic ones topped out near 0.1, and the hits judged relevant sat
 * at 0.25 and above. Retune from recall.jsonl.
 */
export const PROMPT_MIN_SIMILARITY = 0.2
/** How much subject indexing one prompt may do before recall. */
const SUBJECT_CATCHUP = 300
const SUBJECT_CATCHUP_MS = 250

/**
 * A prompt shorter than this is not a query worth recalling against.
 *
 * "yes", "go on", "continue" would seed on whatever tokens they share with the
 * corpus and inject noise on the cheapest turns — the ones where the user is
 * least likely to want a wall of context.
 */
export const MIN_QUERY_LENGTH = 12

/** A first pass this weak gets the expanded second: its best hit covers less than this of the query. */
export const WEAK_SIMILARITY = 0.35

const weak = (out: RecallResult): boolean => !out.hits.length || Math.max(...out.hits.map((h) => h.signals.similarity ?? 0)) < WEAK_SIMILARITY

/** For each role word in the query: its titles, its department titles, and who holds it. None: no second pass. */
const expansion = (query: string, resolved: Resolved): Map<string, string[]> | undefined => {
  const map = new Map<string, string[]>()
  for (const t of queryTerms(query)) {
    const alts = roleSynonyms(t)
    if (!alts.length) continue
    map.set(t, [...alts, ...resolved.words])
  }
  return map.size ? map : undefined
}

const logPass = (ctx: ModuleCtx, session: string | undefined, pass: 1 | 2, out: RecallResult, query: string, resolved: Resolved) =>
  appendRecallLog(ctx.dataDir, {
    at: Date.now(),
    ...(session ? { session } : {}),
    event: 'prompt',
    pass,
    via: out.seed.via,
    terms: queryTerms(query).size,
    expanded: resolved.byTerm.size,
    hits: out.hits.map((h) => ({ id: h.memory.id, score: h.score, sim: h.signals.similarity })),
    shown: [],
    trimmed: [],
    suppressed: [],
    belowMinSim: out.cut.belowMinSim,
    droppedForSize: 0,
    droppedByFloor: out.cut.droppedByFloor,
    constraints: [],
  })

const handler = (payload: unknown, ctx?: ModuleCtx) => {
  if (!ctx?.db || !injectsInto()) return undefined
  const p = (payload ?? {}) as PromptPayload
  const query = typeof p.prompt === 'string' ? userText(p.prompt) : ''
  if (query.length < MIN_QUERY_LENGTH) return undefined

  try {
    const store = new MemoryStore(ctx.db)
    // A slice of subject catch-up per prompt; a sweep does the rest.
    indexSubjects(store, { limit: SUBJECT_CATCHUP, deadline: Date.now() + SUBJECT_CATCHUP_MS })
    const resolved = resolveRoles(store, queryTerms(query))
    const pass = (extra: { seedQuery?: string; synonyms?: Map<string, string[]> } = {}) =>
      recall(query, {
        resolved,
        store,
        seeds: [lexicalSeed(store)],
        asOf: Date.now(),
        // Room for the repeats this session already has to be passed over.
        k: PROMPT_K * 2,
        minSimilarity: PROMPT_MIN_SIMILARITY,
        ...extra,
      })
    let out = pass()
    let passNo: 1 | 2 | undefined
    // EMPTY OR WEAK: ONE EXPANDED RE-QUERY. A role asked for in other words ("who runs marketing",
    // "marketing exec") is re-asked as its titles and the people holding them; if that finds nothing
    // either, nothing is injected and the model says it does not know.
    const synonyms = weak(out) ? expansion(query, resolved) : undefined
    if (synonyms) {
      logPass(ctx, p.session_id, 1, out, query, resolved)
      out = pass({ seedQuery: `${query} ${[...synonyms.values()].flat().join(' ')}`, synonyms })
      passNo = 2
    }

    // Reported to the operator, never to the model: an empty graph is our
    // incompleteness, and saying so on every prompt would spend the injection
    // budget on it.
    if (out.corpusEmpty) return undefined

    // A degraded seed is worth a line EVERY time it happens, because the whole
    // point of the provenance is that lexical-because-off and
    // lexical-because-broken must not look alike from outside.
    if (out.seed.degradedFrom) {
      ctx.log(
        `recall degraded to ${out.seed.via} from ${out.seed.degradedFrom.kind}: ${out.seed.degradedFrom.reason}`,
      )
    }

    const now = Date.now()
    const suppressed = out.hits.filter((h) => shownRecently(store, h.memory.id, p.session_id, now)).map((h) => h.memory.id)
    const fresh = out.hits.filter((h) => !suppressed.includes(h.memory.id)).slice(0, PROMPT_K)
    // An excerpt keeps the lines naming who holds a role the query asked about.
    const wanted = new Set([...queryTerms(query), ...resolved.words, ...[...(synonyms?.values() ?? [])].flat().flatMap((w) => w.split(' '))])
    const lineScore = (line: string) => [...terms(line)].filter((t) => wanted.has(t)).length
    const rendered = renderHits(
      fresh.map((h) => h.memory),
      lineScore,
      PROMPT_BUDGET_BYTES,
      '## Cortex — possibly relevant',
    )
    const shownIds = new Set<string>(rendered.included)
    // Constraints about what this prompt, or a memory it brought up, is about: wherever they were written.
    const seen = constraintsShownSince(ctx.dataDir, p.session_id, now - REPEAT_WINDOW_MS)
    const constraints = applicableConstraints(store, {
      texts: [query],
      topics: fresh.filter((h) => shownIds.has(h.memory.id)).map((h) => `${h.memory.name.replace(/[-_]+/g, ' ')}\n${h.memory.description}`),
      cwd: p.cwd,
      machine: [machineId(), os.hostname()],
      privacy: loadPrivacy(ctx.dataDir),
      skip: (c) => isShown(seen, c) || rendered.text.includes(c.text),
      gate: { people: store.peopleTokens(), ...(p.cwd ? { scope: scopeOfCwd(p.cwd) } : {}) },
      max: PROMPT_MAX_CONSTRAINTS,
      textPhrases: true,
    })
    markConstraintsShown(ctx.dataDir, p.session_id, constraints, now)
    const constraintText = renderConstraints(constraints)
    const depth = depthContext(ctx, query, fresh.map((h) => h.memory).filter((m) => shownIds.has(m.id)), p.session_id)
    appendRecallLog(ctx.dataDir, {
      at: Date.now(),
      ...(p.session_id ? { session: p.session_id } : {}),
      event: 'prompt',
      ...(passNo ? { pass: passNo } : {}),
      via: out.seed.via,
      ...(out.seed.degradedFrom ? { degraded: out.seed.degradedFrom.kind } : {}),
      terms: queryTerms(query).size,
      expanded: resolved.byTerm.size,
      hits: out.hits.map((h) => ({ id: h.memory.id, score: h.score, sim: h.signals.similarity })),
      shown: rendered.included,
      trimmed: rendered.trimmed,
      suppressed,
      belowMinSim: out.cut.belowMinSim,
      droppedForSize: rendered.dropped,
      droppedByFloor: out.cut.droppedByFloor,
      constraints: constraints.map((c) => `${c.memoryId}#${c.ord}`),
    })
    const injected = [constraintText, rendered.included.length ? rendered.text : '', depth].filter(Boolean).join('\n\n')
    if (!rendered.included.length) return injected ? { additionalContext: injected } : undefined

    recordSurfacing(store, rendered.included, p.session_id, now)
    const byId = new Map(fresh.map((h) => [h.memory.id, h.memory]))
    const blocks = rendered.text.split(/\n(?=- \*\*)/).slice(1)
    rememberShown(ctx.dataDir, p.session_id, {
      at: now,
      memories: rendered.included.map((id, i) => ({ id, name: byId.get(id)!.name, text: blocks[i] ?? '' })),
    })

    if (rendered.dropped || out.cut.droppedByFloor) {
      ctx.log(
        `recall: injected ${rendered.included.length}, ` +
          `${out.cut.droppedByFloor} below the relevance floor, ` +
          `${rendered.dropped} did not fit ${PROMPT_BUDGET_BYTES}B`,
      )
    }

    return { additionalContext: injected }
  } catch (err) {
    // A memory tool that can break a turn is worse than no memory tool.
    ctx.log(`recall failed (prompt unaffected): ${err instanceof Error ? err.message : err}`)
    return undefined
  }
}

export default handler
