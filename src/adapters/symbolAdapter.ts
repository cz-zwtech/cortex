import type { CodeSymbol, Entity } from '@/ontology'
import type { Location } from './paths'
import { graphListSymbols } from './graph'

/**
 * Symbols are graph-backed, not filesystem-backed: the adapter reads them from
 * the server's /api/graph/symbols endpoint rather than walking a scope dir.
 * They're surfaced only at user scope (see symbolSpec.validScopes) so a single
 * fetch backs the whole kind regardless of the active project.
 *
 * Read-only kind — write/create/delete are intentionally absent. The data is
 * ingested via POST /api/graph/symbols/upsert from the codegraph package.
 */

const buildEntity = (value: CodeSymbol): Entity<CodeSymbol> => ({
  id: `symbol:${value.id}`,
  kind: 'symbol',
  scope: { type: 'user' },
  // No on-disk path — the artifact lives in the graph. Keep repo:file#name
  // visible as the locator in the inspector header subtitle.
  path: value.id,
  value,
  origin: value,
  raw: '',
})

export const readSymbols = async (loc: Location): Promise<Entity<CodeSymbol>[]> => {
  // Graph-backed and global; project scope reads nothing (symbolSpec only
  // declares the user scope, but reload() calls every adapter per scope).
  if (loc.scope.type !== 'user') return []
  try {
    const symbols = await graphListSymbols({ limit: 5000 })
    return symbols.map(buildEntity)
  } catch {
    return []
  }
}
