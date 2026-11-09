/**
 * Consolidation stages after facets (design 4.8, D7, D13): relations between
 * memories that share a facet, vocabulary upkeep, staleness flags, and tool
 * lessons from repeated tool failures. As with facets, the model proposes,
 * every proposal is checked, and every change is recorded per run so the run
 * reverts whole. No memory text is ever rewritten.
 */
import { createHash } from 'node:crypto'

import type { ContextStore, Span } from '../context/store.js'
import { ingest } from '../ingest.js'
import type { Journal } from '../journal.js'
import { hasSecrets } from '../../../../core/secrets.js'
import type { MemoryStore } from '../store.js'
import type { DerivedEdge, Memory } from '../types.js'
import { FACET_TYPES, type FacetType } from './facets.js'
import { jsonOf } from './model.js'

type Deps = { store: MemoryStore; journal: Journal; machine: string; now?: number }
const TEXT = 600

/** Add an edge as this run's own. One that already existed is left alone and not recorded: reverting the run must not delete it. */
const addOwned = (run: string, src: string, dst: string, rel: DerivedEdge['rel'], score: number, d: Deps, at: number): void => {
  if (src === dst || d.store.derivedEdges(src).some((x) => x.dst === dst && x.rel === rel)) return
  d.store.addDerivedEdge({ src, dst, rel, score }, at)
  d.store.recordOp(run, 'edge', src, dst, rel)
}

// ── relations ────────────────────────────────────────────────────────────────

export const RELATIONS = ['duplicate', 'contradicts', 'evolved_into', 'related', 'none'] as const
export type Relation = (typeof RELATIONS)[number]
export type RelationOp = { a: string; b: string; relation: Relation; newer?: string; why: string }

export const relationsPrompt = (pairs: [Memory, Memory][]): string =>
  [
    'You compare pairs of memories from a personal knowledge system. Reply with ONE JSON object and nothing else.',
    'For each pair say how they relate:',
    '- duplicate: the same fact said twice;',
    '- contradicts: they cannot both be true now (a later change of course, a correction);',
    '- evolved_into: the newer one refines or updates the older without contradicting it;',
    '- related: about the same thing, both still stand;',
    '- none: no real relation.',
    'For contradicts and evolved_into, name the newer one ("a" or "b") by its date and content. Give a short reason.',
    'Answer shape: {"pairs":[{"pair":0,"relation":"contradicts","newer":"b","why":"..."}]}',
    '',
    `Pairs: ${JSON.stringify(
      pairs.map(([a, b], i) => ({
        pair: i,
        a: { name: a.name, written: new Date(a.authoredAt).toISOString().slice(0, 10), text: a.content.slice(0, TEXT) },
        b: { name: b.name, written: new Date(b.authoredAt).toISOString().slice(0, 10), text: b.content.slice(0, TEXT) },
      })),
    )}`,
  ].join('\n')

export const parseRelations = (text: string, pairs: [Memory, Memory][]): { ops: RelationOp[]; rejected: number } => {
  const j = jsonOf(text) as { pairs?: unknown[] } | undefined
  if (!j || !Array.isArray(j.pairs)) return { ops: [], rejected: pairs.length }
  const ops: RelationOp[] = []
  let rejected = 0
  const done = new Set<number>()
  for (const x of j.pairs) {
    const o = x as { pair?: unknown; relation?: unknown; newer?: unknown; why?: unknown }
    const i = typeof o.pair === 'number' ? o.pair : -1
    const rel = typeof o.relation === 'string' ? (o.relation as Relation) : undefined
    const pair = pairs[i]
    if (!pair || done.has(i) || !rel || !RELATIONS.includes(rel)) {
      rejected++
      continue
    }
    const needsNewer = rel === 'contradicts' || rel === 'evolved_into'
    const newer = o.newer === 'a' ? pair[0].id : o.newer === 'b' ? pair[1].id : undefined
    if (needsNewer && !newer) {
      rejected++
      continue
    }
    done.add(i)
    ops.push({ a: pair[0].id, b: pair[1].id, relation: rel, ...(newer ? { newer } : {}), why: typeof o.why === 'string' ? o.why.slice(0, 200) : '' })
  }
  return { ops, rejected }
}

export const applyRelations = (run: string, ops: RelationOp[], d: Deps): number => {
  const at = d.now ?? Date.now()
  let applied = 0
  const edge = (src: string, dst: string, rel: DerivedEdge['rel'], score: number) => addOwned(run, src, dst, rel, score, d, at)
  for (const o of ops) {
    const older = o.newer ? (o.newer === o.a ? o.b : o.a) : undefined
    if (o.relation === 'duplicate') edge(o.a, o.b, 'similar_to', 0.95)
    else if (o.relation === 'related') edge(o.a, o.b, 'similar_to', 0.6)
    else if (o.relation === 'evolved_into') edge(older!, o.newer!, 'evolved_into', 1)
    else if (o.relation === 'contradicts') {
      edge(o.newer!, older!, 'contradicts', 1)
      // The newest is treated as current; the older is flagged for review, never removed (D14).
      d.store.flag(older!, 'contradicted', `by ${o.newer}: ${o.why}`, run, at)
    }
    d.store.judged(o.a, o.b, o.relation, run, at)
    if (o.relation !== 'none') d.journal.appendConsolidation({ run, op: 'relation', args: o, machine: d.machine })
    applied++
  }
  return applied
}

// ── vocabulary ───────────────────────────────────────────────────────────────

export type MergeOp = { type: FacetType; from: string; into: string }

/** Retire facets nothing uses any more. Mechanical: no model needed. */
export const retireUnused = (run: string, d: Deps): number => {
  let n = 0
  for (const h of d.store.unusedFacets()) {
    if (d.store.removeHub(h.id)) {
      d.store.recordOpKind(run, 'hub-removed', h.id, h.name)
      d.journal.appendConsolidation({ run, op: 'retire', args: { hub: h.id }, machine: d.machine })
      n++
    }
  }
  return n
}

export const vocabularyPrompt = (store: MemoryStore): string | undefined => {
  const byType: Record<string, { term: string; uses: number; examples: string[] }[]> = {}
  for (const h of store.hubsOfKind('facet')) {
    const [type, term] = h.name.split(':')
    const users = store.derivedInto(h.id, ['focus', 'about'])
    ;(byType[type!] ??= []).push({ term: term!, uses: users.length, examples: users.slice(0, 3).map((e) => store.get(e.src)?.name ?? e.src) })
  }
  if (!Object.values(byType).some((v) => v.length > 1)) return undefined
  return [
    'You keep the facet vocabulary of a personal knowledge system tidy. Reply with ONE JSON object and nothing else.',
    'Find terms of the SAME type that mean the same thing and should be one term (different spelling, plural, synonym). Only clear cases; when unsure, leave them.',
    'Answer shape: {"merge":[{"type":"concern","from":"caching-layer","into":"caching"}]}  ("into" must be an existing term; prefer the one with more uses)',
    '',
    `Terms by type, with uses and example memories: ${JSON.stringify(byType)}`,
  ].join('\n')
}

export const parseMerges = (text: string, store: MemoryStore): { ops: MergeOp[]; rejected: number } => {
  const j = jsonOf(text) as { merge?: unknown[] } | undefined
  if (!j || !Array.isArray(j.merge)) return { ops: [], rejected: 0 }
  const ops: MergeOp[] = []
  let rejected = 0
  for (const x of j.merge) {
    const o = x as { type?: unknown; from?: unknown; into?: unknown }
    const type = o.type as FacetType
    const ok =
      FACET_TYPES.includes(type) && typeof o.from === 'string' && typeof o.into === 'string' && o.from !== o.into &&
      !!store.getHub(`facet:${type}:${o.from}`) && !!store.getHub(`facet:${type}:${o.into}`)
    if (ok) ops.push({ type, from: o.from as string, into: o.into as string })
    else rejected++
  }
  return { ops, rejected }
}

/** Move every edge from one term to the other, then retire the first. Every removal is recorded, so revert restores it. */
export const applyMerges = (run: string, ops: MergeOp[], d: Deps): number => {
  const at = d.now ?? Date.now()
  let n = 0
  for (const o of ops) {
    const from = `facet:${o.type}:${o.from}`
    const into = `facet:${o.type}:${o.into}`
    const hub = d.store.getHub(from)
    if (!hub || !d.store.getHub(into)) continue
    const move = (src: string, dst: string, rel: DerivedEdge['rel'], score: number) => addOwned(run, src, dst, rel, score, d, at)
    for (const e of d.store.derivedInto(from)) {
      d.store.removeDerivedEdge(e.src, from, e.rel)
      d.store.recordOpKind(run, 'edge-removed', e.src, from, e.rel)
      move(e.src, into, e.rel, e.score)
    }
    for (const e of d.store.derivedEdges(from)) {
      d.store.removeDerivedEdge(from, e.dst, e.rel)
      d.store.recordOpKind(run, 'edge-removed', from, e.dst, e.rel)
      move(into, e.dst, e.rel, e.score)
    }
    d.store.removeHub(from)
    d.store.recordOpKind(run, 'hub-removed', from, hub.name)
    d.journal.appendConsolidation({ run, op: 'merge', args: o, machine: d.machine })
    n++
  }
  return n
}

// ── staleness ────────────────────────────────────────────────────────────────

export const UNCONFIRMED_DAYS = 180
const DAY = 86_400_000
const LAPSE = /\b(?:until|till|expires?(?: on)?|valid (?:until|through)|ends? on)\s+(\d{4}-\d{2}-\d{2})/i

/** Mechanical flags: a stated end date that has passed, and old memories nobody has used in months. */
export const flagStale = (run: string, d: Deps, memories: Memory[]): number => {
  const now = d.now ?? Date.now()
  let n = 0
  for (const m of memories) {
    const lapse = m.content.match(LAPSE)
    if (lapse && Date.parse(lapse[1]!) < now && d.store.flag(m.id, 'condition-lapsed', `says ${lapse[0]}`, run, now)) n++
    const last = d.store.lastSurfaced(m.id)
    if (now - m.authoredAt > UNCONFIRMED_DAYS * DAY && (!last || now - last > UNCONFIRMED_DAYS * DAY) && d.store.flag(m.id, 'unconfirmed', `not written or used in ${UNCONFIRMED_DAYS} days`, run, now)) n++
  }
  return n
}

// ── tool lessons ─────────────────────────────────────────────────────────────

export type ToolFailure = { note: string; reaction: string; session: string }
export const LESSON_MIN = 3

/** Group tool-failure notes by tool and first words of the target; only repeats across sessions are lessons. */
export const lessonCandidates = (notes: ToolFailure[]): { key: string; examples: ToolFailure[] }[] => {
  const groups = new Map<string, ToolFailure[]>()
  for (const n of notes) {
    const key = n.note.split(' failed:')[0]!.split(/\s+/).slice(0, 3).join(' ').toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), n])
  }
  return [...groups].filter(([, v]) => new Set(v.map((x) => x.session)).size >= LESSON_MIN).map(([key, examples]) => ({ key, examples: examples.slice(0, 6) }))
}

export const lessonPrompt = (c: { key: string; examples: ToolFailure[] }): string =>
  [
    'From repeated tool failures and what was done next, write ONE short lesson a future session should follow. Reply with ONE JSON object and nothing else.',
    'If the failures teach nothing general, answer {"lesson":null}.',
    'Answer shape: {"lesson":{"name":"<kebab-case, 3-6 words>","rule":"<one sentence: when X fails, do Y>","why":"<one sentence>"}}',
    '',
    `Failures: ${JSON.stringify(c.examples.map((e) => ({ failure: e.note, next: e.reaction.slice(0, 300) })))}`,
  ].join('\n')

/** Lessons are keyed by the failure group, so a group is judged once whether or not it taught anything. */
export const lessonKey = (key: string): string => `lesson:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`

export const applyLesson = (run: string, key: string, text: string, d: Deps): string | undefined => {
  const at = d.now ?? Date.now()
  const k = lessonKey(key)
  d.store.judged(k, '', 'lesson', run, at)
  const j = jsonOf(text) as { lesson?: { name?: unknown; rule?: unknown; why?: unknown } | null } | undefined
  const l = j?.lesson
  if (!l || typeof l.rule !== 'string' || typeof l.name !== 'string' || !l.rule.trim()) return undefined
  const slug = `tool-lesson-${l.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}`
  const rule = l.rule.trim().replace(/\s+/g, ' ')
  const body = `${rule}\n\n**Why:** ${typeof l.why === 'string' && l.why.trim() ? l.why.trim() : 'learned from repeated tool failures'}\n`
  const content = `---\nname: ${slug}\ndescription: ${rule.slice(0, 140)}\ntype: error\nauthorship: derived\n---\n\n${body}`
  const r = ingest({ content, body, slug, scope: 'user', source: `consolidation:${k}`, machine: d.machine, authoredAt: at }, { store: d.store, journal: d.journal })
  if (r.status !== 'ingested') return undefined
  d.store.recordOpKind(run, 'memory', r.receipt.id)
  d.journal.appendConsolidation({ run, op: 'lesson', args: { memory: r.receipt.id, key }, machine: d.machine })
  return r.receipt.id
}

// ── digests ──────────────────────────────────────────────────────────────────

export const SPAN_TEXT = 4_000
export type DigestOp = { span: Span; keywords: string[]; facets: string[]; summary: string }

const spanText = (span: Span): string => {
  let out = ''
  for (const b of span.blocks) {
    const line = `${b.party ?? b.speaker}: ${b.text.replace(/\s+/g, ' ').slice(0, 500)}\n`
    if (out.length + line.length > SPAN_TEXT) break
    out += line
  }
  return out
}

export const digestPrompt = (spans: Span[], vocab: string[]): string =>
  [
    'You index stretches of past dialogue so they can still be found once their text is archived. Reply with ONE JSON object and nothing else.',
    'For each stretch give: up to 12 keywords a person might later search for (names, tools, decisions, problems); the facets it is about, chosen ONLY from the vocabulary given; and a summary of at most 3 sentences saying what was decided or learned, and why.',
    'Never copy credentials, tokens or keys into any field.',
    'Answer shape: {"digests":[{"span":0,"keywords":["..."],"facets":["concern:caching"],"summary":"..."}]}',
    '',
    `Vocabulary: ${JSON.stringify(vocab)}`,
    '',
    `Stretches: ${JSON.stringify(spans.map((sp, i) => ({ span: i, date: new Date(sp.blocks[0]!.at).toISOString().slice(0, 10), dialogue: spanText(sp) })))}`,
  ].join('\n')

export const parseDigests = (text: string, spans: Span[], vocab: Set<string>): { ops: DigestOp[]; rejected: number } => {
  const j = jsonOf(text) as { digests?: unknown[] } | undefined
  if (!j || !Array.isArray(j.digests)) return { ops: [], rejected: spans.length }
  const ops: DigestOp[] = []
  const done = new Set<number>()
  let rejected = 0
  for (const x of j.digests) {
    const o = x as { span?: unknown; keywords?: unknown; facets?: unknown; summary?: unknown }
    const i = typeof o.span === 'number' ? o.span : -1
    const span = spans[i]
    const summary = typeof o.summary === 'string' ? o.summary.trim().replace(/\s+/g, ' ') : ''
    const keywords = Array.isArray(o.keywords)
      ? [...new Set(o.keywords.filter((k): k is string => typeof k === 'string').map((k) => k.toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '')).filter(Boolean))].slice(0, 12)
      : []
    // A digest is replicated everywhere: one that carries anything secret-shaped is refused whole.
    if (!span || done.has(i) || !summary || summary.length > 800 || !keywords.length || hasSecrets(`${summary} ${keywords.join(' ')}`)) {
      rejected++
      continue
    }
    done.add(i)
    const facets = Array.isArray(o.facets) ? o.facets.filter((f): f is string => typeof f === 'string' && vocab.has(f)).slice(0, 6) : []
    ops.push({ span, keywords, facets, summary })
  }
  return { ops, rejected }
}

export const applyDigests = (run: string, ops: DigestOp[], context: ContextStore, d: Deps & { model: string }): number => {
  const at = d.now ?? Date.now()
  for (const o of ops) {
    const { blocks: _, ...span } = o.span
    context.putDigest(span, { keywords: o.keywords, facets: o.facets, summary: o.summary, made_at: at, made_by: d.model }, run)
    d.journal.appendConsolidation({ run, op: 'digest', args: { span: span.id, keywords: o.keywords, facets: o.facets, summary: o.summary }, machine: d.machine })
  }
  return ops.length
}
