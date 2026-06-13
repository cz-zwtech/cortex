/**
 * §1 content-derivation for memory→file linkage (see memory-file-linkage-spec.md).
 *
 * A body/description token is a file mention when it is PATH-SHAPED: it contains
 * `/` AND its terminal segment carries a file extension. Backtick-quoting is the
 * canonical case (a strong signal), not a requirement. Precision-first — the same
 * spirit as fileMentionMatches: a bare basename (`bus.ts`, no `/`) is excluded to
 * avoid the "db.ts matches every db.ts" false-positive class.
 *
 * Derived paths are kept VERBATIM (the file-stub `name` is the verbatim path,
 * slash-encoded into the id by the existing fileEntryId path) so there is ONE
 * ontology and fileMentionMatches + every consumer work unchanged.
 */

// A token is candidate-extracted from backtick spans (strong signal) and from
// whitespace-delimited prose, then trimmed of surrounding punctuation/quotes.
const BACKTICK = /`([^`]+)`/g
const TRIM_EDGES = /^[("'<\[]+|[)"'>\],.;:!?]+$/g

// Terminal segment must look like `name.ext` — a non-empty base + a short alnum
// extension. Excludes a bare `.ts` (no base) and over-long "extensions".
const FILE_SEGMENT = /[^/\\]+\.[A-Za-z0-9]{1,8}$/
const GLOB = /[*?]|\[[^\]]*\]/ // wildcard tokens are not concrete files
const URLISH = /:\/\// // scheme://… — a URL, not a path
const PKG_SCOPE = /^@[^/]+\/[^/]+$/ // @scope/pkg specifier

/** Is a single trimmed token a concrete, path-shaped file mention? */
export function isFileMention(token: string): boolean {
  if (!token || token.length > 512) return false
  if (URLISH.test(token)) return false
  if (GLOB.test(token)) return false
  if (!token.includes('/')) return false // bare basename — precision-first
  if (PKG_SCOPE.test(token)) return false
  const terminal = token.split('/').pop() ?? ''
  return FILE_SEGMENT.test(terminal)
}

/** Extract the deduped, order-preserving set of path-shaped file mentions from
 *  text (a memory body or description). */
export function deriveFileMentions(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  const add = (raw: string) => {
    const tok = raw.replace(TRIM_EDGES, '')
    if (isFileMention(tok) && !seen.has(tok)) {
      seen.add(tok)
      out.push(tok)
    }
  }

  // 1. backtick spans (the canonical case) — split on whitespace inside the span.
  for (const m of text.matchAll(BACKTICK)) {
    for (const piece of m[1]!.split(/\s+/)) add(piece)
  }
  // 2. bare prose tokens (whitespace-delimited) — catches forgotten backticks.
  for (const piece of text.split(/\s+/)) add(piece)

  return out
}
