/**
 * One consolidation run (design 4.8): stages in order (facets, relations,
 * vocabulary, staleness, tool lessons, digests of cold spans), bounded batches through the model,
 * every operation checked before it is applied, recorded per run so it can be
 * reverted whole, within a per-run batch limit and a daily token cap.
 */
import crypto from 'node:crypto'

import type { ContextStore } from '../context/store.js'
import type { Journal } from '../journal.js'
import type { MemoryStore } from '../store.js'
import { applyFacets, facetPrompt, parseFacets, vocabulary } from './facets.js'
import type { ModelCall } from './model.js'
import {
  applyDigests,
  applyLesson,
  applyMerges,
  applyRelations,
  digestPrompt,
  flagStale,
  lessonCandidates,
  lessonKey,
  lessonPrompt,
  parseDigests,
  parseMerges,
  parseRelations,
  relationsPrompt,
  retireUnused,
  vocabularyPrompt,
} from './stages.js'

export const STAGES = ['facets', 'relations', 'vocabulary', 'staleness', 'lessons', 'digests'] as const
export type Stage = (typeof STAGES)[number]

export type ConsolidateOptions = {
  store: MemoryStore
  journal: Journal
  machine: string
  call: ModelCall
  model: string
  effort?: string
  batchSize?: number
  /** Model calls per run, all stages together. */
  maxBatches?: number
  /** Tokens per rolling 24 hours, all runs together. */
  dailyTokenCap?: number
  stages?: Stage[]
  /** The dialogue store, for tool lessons and digests. Without it those stages are skipped. */
  context?: ContextStore
  dryRun?: boolean
  now?: () => number
}

export type ConsolidateReport = {
  run: string
  batches: number
  ops: number
  rejected: number
  tokens: number
  costUsd: number
  status: 'done' | 'partial' | 'failed' | 'nothing to do' | 'over the daily cap'
  errors: string[]
  remaining: number
  stages: Partial<Record<Stage, number>>
}

export const DEFAULTS = { model: 'haiku', batchSize: 20, maxBatches: 10, dailyTokenCap: 600_000, pairsPerBatch: 10, lessonDays: 30, spansPerBatch: 5 }

export const consolidate = (o: ConsolidateOptions): ConsolidateReport => {
  const now = o.now ?? Date.now
  const run = `c-${now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
  const size = o.batchSize ?? DEFAULTS.batchSize
  const maxBatches = o.maxBatches ?? DEFAULTS.maxBatches
  const stages = new Set(o.stages ?? STAGES)
  const report: ConsolidateReport = { run, batches: 0, ops: 0, rejected: 0, tokens: 0, costUsd: 0, status: 'done', errors: [], remaining: 0, stages: {} }
  const cap = o.dailyTokenCap ?? DEFAULTS.dailyTokenCap
  const spent = () => o.store.tokensSince(now() - 86_400_000) + report.tokens
  const deps = () => ({ store: o.store, journal: o.journal, machine: o.machine, now: now() })
  const count = (stage: Stage, n: number) => {
    report.stages[stage] = (report.stages[stage] ?? 0) + n
    report.ops += n
  }

  if (spent() >= cap) return { ...report, status: 'over the daily cap' }
  if (!o.dryRun) o.store.beginRun({ run, at: now(), stage: [...stages].join(','), model: o.model, effort: o.effort })

  /** Whether another model call fits. Asked only with work in hand, so a stop at the cap is a partial run. */
  const budgetLeft = (): boolean => {
    if (report.batches >= maxBatches) return false
    if (spent() < cap) return true
    if (!report.errors.includes('stopped at the daily token cap')) report.errors.push('stopped at the daily token cap')
    report.status = 'partial'
    return false
  }
  /** One model call, or undefined when the call failed. */
  const ask = (prompt: string): string | undefined => {
    const res = o.call(prompt, { model: o.model, effort: o.effort })
    report.batches++
    report.tokens += res.tokens
    report.costUsd += res.costUsd
    if (res.error) {
      report.errors.push(res.error)
      report.status = 'partial'
      return undefined
    }
    return res.text
  }
  if (stages.has('facets')) {
    const taken = new Set<string>()
    for (;;) {
      // A dry run applies nothing, so the same memories would come back: skip the ones already sent.
      const batch = o.store.withoutFacets(size + taken.size).filter((m) => !taken.has(m.id)).slice(0, size)
      if (!batch.length || !budgetLeft()) break
      for (const m of batch) taken.add(m.id)
      const text = ask(facetPrompt(batch, vocabulary(o.store)))
      if (text === undefined) continue
      const parsed = parseFacets(text, batch)
      report.rejected += parsed.rejected
      count('facets', o.dryRun ? parsed.ops.length + parsed.spine.length : applyFacets(run, parsed.ops, parsed.spine, { ...deps(), now: now() }))
    }
    report.remaining = o.dryRun ? Math.max(0, o.store.withoutFacets(100_000).length - taken.size) : o.store.withoutFacets(100_000).length
  }

  if (stages.has('relations')) {
    const per = DEFAULTS.pairsPerBatch
    // Taken once and chunked, so a dry run does not see the same pairs again.
    const pairs = o.store.unjudgedPairs(per * Math.max(1, maxBatches - report.batches))
    for (let i = 0; i < pairs.length && budgetLeft(); i += per) {
      const chunk = pairs.slice(i, i + per)
      const text = ask(relationsPrompt(chunk))
      if (text === undefined) continue
      const parsed = parseRelations(text, chunk)
      report.rejected += parsed.rejected
      count('relations', o.dryRun ? parsed.ops.length : applyRelations(run, parsed.ops, deps()))
    }
  }

  if (stages.has('vocabulary')) {
    count('vocabulary', o.dryRun ? o.store.unusedFacets().length : retireUnused(run, deps()))
    const prompt = vocabularyPrompt(o.store)
    const text = prompt && budgetLeft() ? ask(prompt) : undefined
    if (text !== undefined) {
      const parsed = parseMerges(text, o.store)
      report.rejected += parsed.rejected
      count('vocabulary', o.dryRun ? parsed.ops.length : applyMerges(run, parsed.ops, deps()))
    }
  }

  if (stages.has('staleness') && !o.dryRun) count('staleness', flagStale(run, deps(), o.store.all()))

  if (stages.has('lessons') && o.context) {
    const since = now() - DEFAULTS.lessonDays * 86_400_000
    for (const c of lessonCandidates(o.context.toolFailures(since))) {
      if (o.store.wasJudged(lessonKey(c.key), '')) continue
      if (!budgetLeft()) break
      const text = ask(lessonPrompt(c))
      if (text === undefined || o.dryRun) continue
      if (applyLesson(run, c.key, text, deps())) count('lessons', 1)
    }
  }

  if (stages.has('digests') && o.context) {
    const per = DEFAULTS.spansPerBatch
    const vocab = o.store.hubsOfKind('facet').map((h) => h.name)
    // Taken once and chunked, so a dry run does not see the same spans again.
    const spans = o.context.coldSpans(per * Math.max(1, maxBatches - report.batches), now())
    for (let i = 0; i < spans.length && budgetLeft(); i += per) {
      const chunk = spans.slice(i, i + per)
      const text = ask(digestPrompt(chunk, vocab))
      if (text === undefined) continue
      const parsed = parseDigests(text, chunk, new Set(vocab))
      report.rejected += parsed.rejected
      count('digests', o.dryRun ? parsed.ops.length : applyDigests(run, parsed.ops, o.context, { ...deps(), model: o.model }))
    }
  }

  if (report.batches && report.errors.length === report.batches) report.status = 'failed'
  else if (!report.batches && !report.ops) report.status = 'nothing to do'
  if (!o.dryRun) o.store.endRun(run, { batches: report.batches, ops: report.ops, rejected: report.rejected, tokens: report.tokens, costUsd: report.costUsd, status: report.status, note: report.errors.slice(0, 3).join(' | ') || undefined })
  return report
}

/**
 * Undo a run whole, and say so in the journal. Memories the run wrote (tool
 * lessons) are tombstoned, so a rebuild from the journal does not bring them back.
 */
export const revert = (run: string, deps: { store: MemoryStore; journal: Journal; machine: string; context?: ContextStore }) => {
  const r = { ...deps.store.revertRun(run), digests: deps.context?.dropDigests(run) ?? 0 }
  for (const id of r.memories) {
    const hash = deps.store.journalHashOf(id)
    if (hash) deps.journal.appendTombstone({ memoryId: id, targetHash: hash, machine: deps.machine })
    deps.store.deleteCascade(id)
  }
  deps.journal.appendConsolidation({ run, op: 'revert', args: r, machine: deps.machine })
  return r
}
