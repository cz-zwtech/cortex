import { parse, stringify } from './frontmatter'

export interface MemoryFields {
  name: string
  description: string
  type: string
}

/**
 * Serialize a memory back to a frontmatter file WITHOUT losing fields the editor
 * doesn't model.
 *
 * The `Memory` ontology captures only name/description/type/body, but a memory
 * file's frontmatter carries far more: `id`, the external normalizer's nested
 * `metadata:` block (node_type/status/next_step/links/repo for THREADS), machine
 * lineage, pinned, scope, authorship, etc. The old serializer wrote ONLY the
 * three modeled fields, so any UI edit destroyed the rest — turning a thread into
 * a dead memory (the resume surface would silently lose its next_step).
 *
 * Fix: start from the ORIGINAL frontmatter when editing and override only the
 * modeled fields. `type` is written only for a NEW file or one that already had a
 * TOP-LEVEL `type` — a normalized memory/thread keeps its kind under `metadata`,
 * so we must not inject a competing top-level `type` (deriveNodeKind would still
 * resolve it, but the noise is avoidable).
 */
export const serializeMemory = (
  fields: MemoryFields,
  body: string,
  originalRaw?: string,
): string => {
  const base = originalRaw ? (parse(originalRaw).data as Record<string, unknown>) : {}
  const merged: Record<string, unknown> = {
    ...base,
    name: fields.name,
    description: fields.description,
  }
  if (!originalRaw || 'type' in base) merged.type = fields.type
  return stringify(merged, body)
}
