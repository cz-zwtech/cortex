import type { Kind } from '@/ontology'
import type { Reference } from './types'
import { referenceExtractors } from './extractors'

export const referrersOf = (entityId: string, refs: Reference[]): Reference[] =>
  refs.filter((r) => r.to === entityId)

export const referencesFrom = (entityId: string, refs: Reference[]): Reference[] =>
  refs.filter((r) => r.from === entityId)

/**
 * Whether a kind can structurally participate in the reference graph at all.
 * Used by the UI to decide if the References panel is worth rendering.
 *
 * A kind participates if it can be a *source* (has an extractor) OR a *target*
 * (can be named in `kindsThatCanBeReferenced`).
 */
const kindsThatCanBeReferenced: readonly Kind[] = [
  'agent', 'command', 'skill', 'hook', 'mcp', 'memory', 'claudemd', 'rule',
]

export const kindParticipatesInRefs = (kind: Kind): boolean =>
  referenceExtractors[kind] !== undefined ||
  kindsThatCanBeReferenced.includes(kind)
