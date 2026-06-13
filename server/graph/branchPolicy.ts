/**
 * Branch-stability classification for the codegraph freshness policy.
 *
 * The graph is refreshed on TWO triggers (spec Phase 2): on-query (always) and
 * on-completion (after a change lands). On-completion sync is the one that can
 * become noise — a churny, short-lived branch (an epic, a wip spike) doesn't
 * benefit from re-ingesting on every commit. So we classify each branch:
 *
 *   - `core`      — a stable, long-lived alignment branch (main/develop/a
 *                   feature branch swarm epics fork off). Syncs on completion
 *                   AND on query.
 *   - `ephemeral` — everything else (epic/*, wip/*, ad-hoc). Syncs on query
 *                   ONLY; the on-completion trigger no-ops (unless --force).
 *
 * Pure + data-driven: the core set is a glob list from
 * `CKN_CODEGRAPH_CORE_BRANCHES` (comma-separated), defaulting to the common
 * trunk + integration patterns. This is "classify, don't binary"
 * ([[feedback-it-depends-architecture]]) — the policy is one config knob, not
 * an all-or-nothing sync.
 */

/** The default core-branch glob set when CKN_CODEGRAPH_CORE_BRANCHES is unset. */
export const DEFAULT_CORE_BRANCHES = [
  'main',
  'master',
  'develop',
  'release/*',
  'feature/*',
  'integration/*',
] as const

export interface BranchPolicyConfig {
  /** Glob patterns naming the core branches. Falls back to the env / default. */
  coreBranches?: string[]
}

export type BranchClass = 'core' | 'ephemeral'

/**
 * Resolve the configured core-branch glob list: explicit `cfg.coreBranches`
 * wins, else `CKN_CODEGRAPH_CORE_BRANCHES` (comma-separated), else the default.
 * Empty / whitespace entries are dropped. An explicitly-empty list means "no
 * branch is core" (everything ephemeral) — only an *absent* value falls back.
 */
export function coreBranchPatterns(cfg?: BranchPolicyConfig): string[] {
  if (cfg?.coreBranches) return cfg.coreBranches.map((p) => p.trim()).filter(Boolean)
  const env = process.env.CKN_CODEGRAPH_CORE_BRANCHES
  if (env !== undefined) {
    return env
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
  }
  return [...DEFAULT_CORE_BRANCHES]
}

/**
 * Compile a single branch glob to a RegExp. Supports `*` (any run of non-`/`
 * chars within a path segment) and `**` (any run including `/`); every other
 * character is matched literally (regex metachars escaped). Anchored full-match,
 * case-sensitive (git branch names are).
 */
function globToRegExp(glob: string): RegExp {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*' // ** — crosses '/'
        i++
      } else {
        out += '[^/]*' // * — within a segment
      }
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  out += '$'
  return new RegExp(out)
}

/** True when `branch` matches any of the core glob patterns. */
export function matchesCore(branch: string, patterns: string[]): boolean {
  if (!branch) return false
  return patterns.some((p) => globToRegExp(p).test(branch))
}

/**
 * Classify a branch as `core` or `ephemeral` against the configured core set.
 * Empty / unknown branch → `ephemeral` (the safe default: don't auto-sync on
 * completion for something we can't place).
 */
export function classifyBranch(branch: string, cfg?: BranchPolicyConfig): BranchClass {
  return matchesCore(branch, coreBranchPatterns(cfg)) ? 'core' : 'ephemeral'
}
