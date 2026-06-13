/**
 * Path-shape normalization for the ABOUT tier-1 file-knowledge join.
 *
 * `mentions_files` is stored VERBATIM from memory frontmatter (see sync.ts —
 * `fileEntryId` just slash-replaces whatever string the author wrote), so stored
 * paths are heterogeneous: absolute (`/path/to/repo/bin/x.ts`), machine-rooted
 * (`/home/claude/cortex/bin/x.ts`), repo-prefixed (`cortex/bin/x.ts`),
 * cwd-relative (`./x.ts`, `../../x.ts`), or home-tilde (`~/.claude/x`). The
 * PreToolUse edit target, by contrast, resolves to a REPO-RELATIVE path.
 *
 * A naive exact-match join returns zero matches forever and is indistinguishable
 * from "no knowledge". These helpers normalize BOTH sides and suffix-match on a
 * path-segment boundary so every stored shape that refers to the same repo file
 * matches the one repo-relative target — including the cross-machine duplicates
 * that an exact match would fracture.
 */

/** Reduce a path to a comparable POSIX form: unify separators, strip a leading
 * `~/`, drop leading `./` / `../` segments, collapse repeated separators. Does
 * NOT strip a leading `/` — absoluteness is handled at match time. */
export function toComparablePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^~\//, '')
    .replace(/^(?:\.\.?\/)+/, '')
    .replace(/\/{2,}/g, '/')
}

/**
 * True when a memory's stored `mentions_files` path refers to the same file as
 * `repoRelTarget` (the repo-relative PreToolUse edit target). Both sides are
 * normalized; the stored path (which may carry an absolute / machine / repo
 * prefix) must EQUAL the target or END WITH it on a path-segment boundary.
 *
 * Stored paths SHORTER than the target (e.g. a bare basename `db.ts` vs target
 * `server/graph/db.ts`) do NOT match — tier-1 favors precision over the
 * "db.ts matches every db.ts" false-positive class.
 */
export function fileMentionMatches(storedPath: string, repoRelTarget: string): boolean {
  const t = toComparablePath(repoRelTarget).replace(/^\/+/, '')
  if (!t) return false
  const s = toComparablePath(storedPath).replace(/^\/+/, '')
  if (!s) return false
  return s === t || s.endsWith('/' + t)
}
