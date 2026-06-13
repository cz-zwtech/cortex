import { z } from 'zod'

/**
 * A code-graph Symbol — a function/class/method/etc. extracted from source by
 * the codegraph package and folded into the singular Cortex graph. Read-only
 * in the UI: symbols are derived data (a deterministic projection of source),
 * regenerated per host, never hand-edited. Surfaced as a kind so the user can
 * filter/inspect AST data in the graph views.
 *
 * Field set mirrors codegraph/src/types.ts SymbolNode + Lifecycle, flattened.
 */
export const CodeSymbol = z.object({
  id: z.string(),
  name: z.string(),
  symbolKind: z.string(),
  repo: z.string(),
  file: z.string(),
  lang: z.string().optional(),
  line: z.number().optional(),
  signature: z.string().optional(),
  // Forgetting-lifecycle fields (principle #2).
  base: z.number().optional(),
  stickiness: z.number().optional(),
  centrality: z.number().optional(),
  lastSeen: z.number().optional(),
  pinned: z.boolean().optional(),
  groundTruthValid: z.boolean().optional(),
  /**
   * Absolute filesystem root the extractor walked (per repo). `file` is
   * repo-relative; join with `root` for the real on-disk path. Empty until the
   * repo is re-ingested on an install carrying the 0012 Symbol.root migration.
   */
  root: z.string().optional(),
})
export type CodeSymbol = z.infer<typeof CodeSymbol>
