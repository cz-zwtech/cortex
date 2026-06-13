import type { AnyEntity, Kind } from '@/ontology'

/**
 * How a reference was discovered. Keeps the provenance so the UI can explain
 * *why* something is considered a reference, and so we can trust structured
 * sources (frontmatter, imports) more than heuristic ones (prose).
 */
export type RefSource =
  | { kind: 'frontmatter'; field: string }
  | { kind: 'import'; path: string }
  | { kind: 'tool'; tool: string }
  | { kind: 'matcher'; pattern: string }
  | { kind: 'prose' }

/** Reference as emitted by an extractor, before resolution against the entity index. */
export interface RawRef {
  toKind: Kind
  toName: string
  source: RefSource
}

/** Resolved reference in the graph. `to` is a synthetic id when `broken`. */
export interface Reference {
  from: string
  to: string
  kind: Kind
  name: string
  source: RefSource
  broken: boolean
}

export interface EntityIndex {
  lookup: (kind: Kind, name: string) => AnyEntity | null
  namesByKind: (kind: Kind) => string[]
}

export type ReferenceExtractor = (entity: AnyEntity, ctx: EntityIndex) => RawRef[]
