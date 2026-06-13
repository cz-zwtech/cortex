/**
 * §2 reconciliation for memory→file linkage (memory-file-linkage-spec.md, Fable).
 *
 * Keyed by (src,dst,rel) — exactly ONE MENTIONS_FILE edge per (memory,file). The
 * author's frontmatter edit is INTENT and wins in both directions: listing a file
 * upgrades a derived edge to `frontmatter`; retracting it downgrades to `derived`
 * (body still mentions it) or removes it (body never had it). A purely body-derived
 * edge persists while the body derives it, and is removed when the body drops it.
 *
 * Pure + side-effect-free: returns the set of edge OPS for one memory. The caller
 * (sync per-file, or the 0009 backfill corpus-wide) applies them. A settled state
 * yields zero ops — that is the idempotency guarantee. Legacy NULL provenance is
 * mapped to 'frontmatter' by the caller before this runs (every pre-existing
 * memory edge came from frontmatter).
 */
export type EdgeProvenance = 'frontmatter' | 'derived'

export interface ExistingFileEdge {
  dst: string
  provenance: EdgeProvenance
}

export type ReconcileAction = 'create-frontmatter' | 'create-derived' | 'upgrade' | 'downgrade' | 'remove'

export interface ReconcileOp {
  dst: string
  action: ReconcileAction
}

/** Decide the edge ops for ONE memory given its existing MENTIONS_FILE edges, the
 *  files its frontmatter lists, and the files its body derives. Emits only
 *  ACTIONABLE ops; a dst left as-is produces nothing (so a settled corpus = []). */
export function reconcileFileEdgeOps(
  existing: ExistingFileEdge[],
  frontmatter: string[],
  derived: string[],
): ReconcileOp[] {
  const byDst = new Map(existing.map((e) => [e.dst, e.provenance]))
  const fm = new Set(frontmatter)
  const dv = new Set(derived)
  const ops: ReconcileOp[] = []

  for (const dst of new Set([...byDst.keys(), ...fm, ...dv])) {
    const prov = byDst.get(dst) // undefined = no edge yet
    const f = fm.has(dst)
    const d = dv.has(dst)

    if (!prov) {
      if (f) ops.push({ dst, action: 'create-frontmatter' })
      else if (d) ops.push({ dst, action: 'create-derived' })
      continue
    }
    if (prov === 'derived') {
      if (f) ops.push({ dst, action: 'upgrade' }) // author claimed it → intent
      else if (!d) ops.push({ dst, action: 'remove' }) // body dropped it
      // derived + body still derives → keep (no op)
      continue
    }
    // prov === 'frontmatter'
    if (f) continue // still listed → keep
    if (d) ops.push({ dst, action: 'downgrade' }) // author retracted, body still has it
    else ops.push({ dst, action: 'remove' }) // author retracted, body never had it
  }
  return ops
}
