import { all, get, run } from './db.js'

/** Resolve a raw node/machine id to its canonical id (identity if no alias). */
export function canonicalId(rawId: string): string {
  if (!rawId) return rawId
  const row = get<{ canonical_id: string }>(
    'SELECT canonical_id FROM node_aliases WHERE alias_id = ?',
    rawId,
  )
  return row?.canonical_id ?? rawId
}

/** Upsert an alias → canonical mapping. No-op when alias === canonical. */
export function setAlias(aliasId: string, canonical: string): void {
  if (!aliasId || !canonical || aliasId === canonical) return
  run(
    `INSERT INTO node_aliases (alias_id, canonical_id) VALUES (?, ?)
     ON CONFLICT(alias_id) DO UPDATE SET canonical_id = excluded.canonical_id`,
    aliasId,
    canonical,
  )
}

export function allAliases(): { aliasId: string; canonicalId: string }[] {
  return all<{ alias_id: string; canonical_id: string }>(
    'SELECT alias_id, canonical_id FROM node_aliases',
  ).map((r) => ({ aliasId: r.alias_id, canonicalId: r.canonical_id }))
}
