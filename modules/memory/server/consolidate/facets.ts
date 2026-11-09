/**
 * Facets and the spine (design 4.5, D6, D7). Each memory gets one focus facet
 * and links to its other facets; work facets form the spine through part_of.
 * The vocabulary is fluid: the current terms are given to the model so it
 * reuses them, and new ones are added only when none fits.
 */
import type { Journal } from '../journal.js'
import type { MemoryStore } from '../store.js'
import type { Memory } from '../types.js'
import { jsonOf } from './model.js'

export const FACET_TYPES = ['subject', 'work', 'layer', 'concern'] as const
export type FacetType = (typeof FACET_TYPES)[number]
export type Facet = { type: FacetType; term: string }
export type FacetOp = { memory: string; focus: Facet; about: Facet[] }
export type SpineOp = { child: string; parent: string }

const TERM = /^[a-z0-9][a-z0-9-]{0,47}$/
const MAX_ABOUT = 6
const BODY_CHARS = 700

export const facetHubId = (f: Facet) => `facet:${f.type}:${f.term}`

const normalise = (t: unknown): string | undefined => {
  if (typeof t !== 'string') return undefined
  const s = t.toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return TERM.test(s) ? s : undefined
}
const facetOf = (x: unknown): Facet | undefined => {
  const o = x as { type?: unknown; term?: unknown } | undefined
  const type = typeof o?.type === 'string' ? (o.type.toLowerCase() as FacetType) : undefined
  const term = normalise(o?.term)
  return type && FACET_TYPES.includes(type) && term ? { type, term } : undefined
}

export const vocabulary = (store: MemoryStore): Record<FacetType, string[]> => {
  const out = { subject: [], work: [], layer: [], concern: [] } as Record<FacetType, string[]>
  for (const h of store.hubsOfKind('facet')) {
    const [type, term] = h.name.split(':') as [FacetType, string]
    if (FACET_TYPES.includes(type) && term) out[type].push(term)
  }
  return out
}

export const facetPrompt = (batch: Memory[], vocab: Record<FacetType, string[]>): string => {
  const items = batch.map((m) => ({ id: m.id, name: m.name, description: m.description, text: m.content.slice(0, BODY_CHARS) }))
  return [
    'You assign facets to memories of a personal knowledge system. Reply with ONE JSON object and nothing else.',
    '',
    'Facet types:',
    '- subject: who or what it is about (a person, client, product, system).',
    '- work: the engagement, project or component it came from. Give the spine: each work term\'s parent work, if any.',
    '- layer: how deep it sits: recipe (a concrete step), technique (a reusable method), kitchen (the setup or environment), palate (taste, preference, principle).',
    '- concern: the cross-cutting pattern (inter-service-communication, caching, auth, data-ownership, testing, deployment, ...).',
    '',
    'Rules: exactly one focus facet per memory (the facet it is mainly about), plus up to 6 more under "about". Terms are lower-case words joined by hyphens, at most 48 characters. REUSE an existing term whenever one fits; add a new term only when none does.',
    '',
    `Existing terms: ${JSON.stringify(vocab)}`,
    '',
    'Answer shape: {"memories":[{"id":"<id>","focus":{"type":"concern","term":"caching"},"about":[{"type":"work","term":"..."}]}],"spine":[{"child":"<work term>","parent":"<work term>"}]}',
    '',
    `Memories: ${JSON.stringify(items)}`,
  ].join('\n')
}

/** Every operation is checked before anything is applied; what fails a check is counted, never applied. */
export const parseFacets = (text: string, batch: Memory[]): { ops: FacetOp[]; spine: SpineOp[]; rejected: number } => {
  const j = jsonOf(text) as { memories?: unknown[]; spine?: unknown[] } | undefined
  if (!j || !Array.isArray(j.memories)) return { ops: [], spine: [], rejected: batch.length }
  const ids = new Set(batch.map((m) => m.id))
  const ops: FacetOp[] = []
  let rejected = 0
  const seen = new Set<string>()
  for (const x of j.memories) {
    const o = x as { id?: unknown; focus?: unknown; about?: unknown }
    const focus = facetOf(o.focus)
    if (typeof o.id !== 'string' || !ids.has(o.id) || seen.has(o.id) || !focus) {
      rejected++
      continue
    }
    seen.add(o.id)
    const about = (Array.isArray(o.about) ? o.about : []).map(facetOf).filter((f): f is Facet => !!f && facetHubId(f) !== facetHubId(focus)).slice(0, MAX_ABOUT)
    ops.push({ memory: o.id, focus, about })
  }
  const spine: SpineOp[] = []
  for (const x of Array.isArray(j.spine) ? j.spine : []) {
    const child = normalise((x as { child?: unknown }).child)
    const parent = normalise((x as { parent?: unknown }).parent)
    if (child && parent && child !== parent) spine.push({ child, parent })
    else rejected++
  }
  return { ops, spine, rejected }
}

/** Apply checked operations: hubs, focus and about edges, the spine. Recorded per run, and journaled. */
export const applyFacets = (run: string, ops: FacetOp[], spine: SpineOp[], deps: { store: MemoryStore; journal: Journal; machine: string; now?: number }): number => {
  const { store, journal, machine } = deps
  const at = deps.now ?? Date.now()
  let applied = 0
  const hub = (f: Facet) => {
    const id = facetHubId(f)
    if (!store.getHub(id)) {
      store.upsertHub({ id, kind: 'facet', name: `${f.type}:${f.term}` })
      store.recordOp(run, 'hub', id)
    }
    return id
  }
  const edge = (src: string, dst: string, rel: 'focus' | 'about' | 'part_of') => {
    store.addDerivedEdge({ src, dst, rel, score: 1 }, at)
    store.recordOp(run, 'edge', src, dst, rel)
  }
  for (const o of ops) {
    edge(o.memory, hub(o.focus), 'focus')
    for (const f of o.about) edge(o.memory, hub(f), 'about')
    journal.appendConsolidation({ run, op: 'facets', args: { memory: o.memory, focus: o.focus, about: o.about }, machine })
    applied++
  }
  for (const s of spine) {
    const child = hub({ type: 'work', term: s.child })
    const parent = hub({ type: 'work', term: s.parent })
    // A part_of loop would make the spine a cycle: the second edge of any loop is refused.
    if (store.derivedEdges(parent).some((e) => e.rel === 'part_of' && e.dst === child)) continue
    edge(child, parent, 'part_of')
    journal.appendConsolidation({ run, op: 'spine', args: s, machine })
    applied++
  }
  return applied
}
