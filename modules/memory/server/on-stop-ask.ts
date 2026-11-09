/**
 * Stop — before a reply ends by asking the user a fact, look for it in memory.
 *
 * A session can ask the user a fact that memory already holds (who holds a
 * role, when a roster memory says so) because no recall runs before the
 * question. A reply that ends with a factual
 * question gets one recall on that question; if memory holds something that
 * clears the prompt-time floor, the turn goes back once with the hits, to
 * answer from them or say they do not answer it. Decision and permission
 * questions ("should I go ahead?") are the user's to answer and pass.
 *
 * Once only: `stop_hook_active` marks the continuation this produced, and it
 * never blocks that one, so it cannot loop.
 */

import type { ModuleCtx } from '../../../core/ctx.js'
import { renderHits } from './inject.js'
import { recall } from './recall.js'
import { appendRecallLog } from './recallLog.js'
import { queryTerms, terms } from './relevance.js'
import { lexicalSeed } from './seed.js'
import { MemoryStore } from './store.js'
import { indexSubjects, resolveRoles } from './subjects.js'
import { lastReply } from './ruleAudit.js'
import { PROMPT_MIN_SIMILARITY } from './on-user-prompt.js'

type Payload = { session_id?: string; transcript_path?: string; last_assistant_message?: string; stop_hook_active?: boolean; agent_id?: string }

/** Questions that hand the user a decision, not ones memory could answer. */
const DECISION =
  /\b(?:should I|shall I|shall we|should we|do you want|would you like|want me to|ok to|okay to|okay if|ok if|proceed|go ahead|confirm|approve|prefer|which (?:option|approach|one|way)|is that (?:ok|okay|right|fine|correct)|sound good|does that work|ready (?:to|for)|anything else|let me know)\b/i

/**
 * Questions asking leave to do something: also the user's to answer. Matched on
 * the permission, never a bare "can": "can the API take 10k users?" is a fact.
 * Otherwise "can these records leave this machine?" would be bounced with
 * unrelated memories.
 */
const PERMISSION =
  /\b(?:can|may|could)\b[^?]{0,60}\b(?:leave|share|send|publish|post|forward|release|disclose|move|copy|sync|use|be (?:shared|sent|published|posted|released|moved|copied|synced|used))\b|\b(?:is it|would it be|is that|is this) (?:ok|okay|fine|alright|acceptable|allowed)\b|\b(?:allowed|permitted) to\b|\bbe allowed\b/i

/**
 * The question a reply ends with, or null. Only a closing question counts: one
 * asked mid-reply and then answered is not waiting on the user.
 */
export const closingQuestion = (reply: string): string | null => {
  const text = reply.replace(/```[\s\S]*?```/g, ' ').trim()
  const last = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  const plain = last.replace(/[*_`>#-]+/g, ' ').trim()
  if (!plain.endsWith('?')) return null
  const sentences = plain.split(/(?<=[.!?])\s+/)
  const q = sentences.filter((s) => s.endsWith('?')).pop() ?? ''
  if (!q || DECISION.test(q) || PERMISSION.test(q)) return null
  return q
}

/** The least coverage of the question a hit needs to bounce a turn (the prompt floor only hints). */
export const ASK_MIN_SIMILARITY = 0.5

/** What the hits may take of the block reason. */
const ASK_BUDGET_BYTES = 1_800

export default (payload: unknown, ctx?: ModuleCtx) => {
  const p = (payload ?? {}) as Payload
  if (!ctx?.db || p.agent_id || p.stop_hook_active) return undefined
  try {
    const reply = p.last_assistant_message ?? (p.transcript_path ? lastReply(p.transcript_path) : '')
    const question = reply ? closingQuestion(reply) : null
    if (!question) return undefined
    const store = new MemoryStore(ctx.db)
    indexSubjects(store, { limit: 300, deadline: Date.now() + 200 })
    const resolved = resolveRoles(store, queryTerms(question))
    const out = recall(question, { store, seeds: [lexicalSeed(store)], asOf: Date.now(), k: 3, minSimilarity: PROMPT_MIN_SIMILARITY, resolved })
    // Bouncing a turn costs more than injecting a hint, so it needs more: a hit that covers
    // the question, not one that shares a word with it.
    const strong = out.hits.filter((h) => (h.signals.similarity ?? 0) >= ASK_MIN_SIMILARITY && (h.signals.matched?.terms ?? 0) >= 2)
    if (!strong.length) return undefined
    const wanted = new Set([...queryTerms(question), ...resolved.words])
    const rendered = renderHits(
      strong.map((h) => h.memory),
      (line) => [...terms(line)].filter((t) => wanted.has(t)).length,
      ASK_BUDGET_BYTES,
      '## Cortex — memory on that question',
    )
    if (!rendered.included.length) return undefined
    appendRecallLog(ctx.dataDir, {
      at: Date.now(),
      ...(p.session_id ? { session: p.session_id } : {}),
      event: 'ask',
      via: out.seed.via,
      terms: queryTerms(question).size,
      expanded: resolved.byTerm.size,
      hits: strong.map((h) => ({ id: h.memory.id, score: h.score, sim: h.signals.similarity })),
      shown: rendered.included,
      trimmed: rendered.trimmed,
      suppressed: [],
      belowMinSim: out.cut.belowMinSim,
      droppedForSize: rendered.dropped,
      droppedByFloor: out.cut.droppedByFloor,
      constraints: [],
    })
    return {
      decision: 'deny' as const,
      reason:
        'Your reply ends by asking the user a question that memory may already answer. ' +
        'Check these first: if one answers it, use it and drop or narrow the question; if none does, ask as before and say memory had no answer.\n\n' +
        rendered.text,
    }
  } catch (err) {
    ctx.log(`ask check skipped: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}
