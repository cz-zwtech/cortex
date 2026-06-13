import type { AnyEntity, Kind } from '@/ontology'
import { kindSpecs } from '@/ontology'
import type { EntityIndex, Reference } from './types'
import { referenceExtractors } from './extractors'

const brokenId = (kind: Kind, name: string): string => `__broken__:${kind}:${name}`

const buildIndex = (entities: AnyEntity[]): EntityIndex => {
  const byKey = new Map<string, AnyEntity>()
  const byKind = new Map<Kind, string[]>()
  for (const e of entities) {
    const spec = kindSpecs[e.kind]
    const name = spec.nameOf(e.value)
    if (!name) continue
    byKey.set(`${e.kind}::${name}`, e)
    const list = byKind.get(e.kind) ?? []
    list.push(name)
    byKind.set(e.kind, list)
  }
  return {
    lookup: (kind, name) => byKey.get(`${kind}::${name}`) ?? null,
    namesByKind: (kind) => byKind.get(kind) ?? [],
  }
}

/**
 * Build the reference graph over every entity.
 *
 * Phase 1: index entities by (kind, name) — needed so prose scanners know
 * which names are "real".
 * Phase 2: run each kind's extractor, resolving raw refs against the index.
 * Unresolved refs are kept with `broken: true` so the UI can warn.
 *
 * Self-references (an entity pointing at itself via prose, etc.) are dropped.
 * Duplicate refs from the same source are de-duplicated per (from, to, source).
 */
export const buildReferenceGraph = (entities: AnyEntity[]): Reference[] => {
  const index = buildIndex(entities)
  const refs: Reference[] = []
  const seen = new Set<string>()

  for (const from of entities) {
    const extract = referenceExtractors[from.kind]
    if (!extract) continue
    for (const raw of extract(from, index)) {
      const target = index.lookup(raw.toKind, raw.toName)
      if (target && target.id === from.id) continue
      const to = target?.id ?? brokenId(raw.toKind, raw.toName)
      const key = `${from.id}→${to}::${raw.source.kind}:${'field' in raw.source ? raw.source.field : 'path' in raw.source ? raw.source.path : ''}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push({
        from: from.id,
        to,
        kind: raw.toKind,
        name: raw.toName,
        source: raw.source,
        broken: !target,
      })
    }
  }
  return refs
}
