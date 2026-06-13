import { parse } from '@/adapters'

/**
 * Parse an entity's raw file into frontmatter data. Each extractor calls this
 * per-entity; the adapters already parse during load, but our Zod schemas
 * don't yet carry every reference-bearing field (skills:, mcpServers:, etc.)
 * so we reach back to the raw source.
 *
 * Returns an empty object when the file has no frontmatter or is malformed.
 */
export const frontmatterOf = (raw: string | undefined): Record<string, unknown> => {
  if (!raw) return {}
  return parse(raw).data
}

export const fmStringList = (fm: Record<string, unknown>, key: string): string[] => {
  const v = fm[key]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string') return v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
  return []
}

export const fmString = (fm: Record<string, unknown>, key: string): string | null => {
  const v = fm[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}
