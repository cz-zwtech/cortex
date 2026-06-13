#!/usr/bin/env tsx
/**
 * ABOUT tier-1 path-shape guard (Item-2 slice 1).
 *
 * The single failure mode Fable flagged: mentions_files is stored VERBATIM from
 * memory frontmatter (sync.ts) — so stored paths are absolute, machine-rooted,
 * repo-prefixed, cwd-relative (./ ../), or home-tilde — while the PreToolUse
 * edit target resolves to a REPO-RELATIVE path. An exact-match join returns zero
 * forever and looks identical to "no knowledge". `fileMentionMatches` normalizes
 * BOTH sides and suffix-matches on a path-segment boundary.
 *
 * Fixtures are taken VERBATIM from the real graph's stored mentions_files shapes
 * (read-only sample, 2026-06-10) so this guards the actual data, not an assumed
 * shape. Pure (no DB) — mirrors test/graph/branch-policy.test.ts.
 */
import assert from 'node:assert/strict'

const { toComparablePath, fileMentionMatches } = await import('../../server/graph/fileMatch.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// ── toComparablePath: normalization primitive ───────────────────────────────
{
  assert.equal(toComparablePath('server\\graph\\db.ts'), 'server/graph/db.ts')
  ok('backslashes → POSIX')
  assert.equal(toComparablePath('./app.js'), 'app.js')
  ok('leading ./ stripped')
  assert.equal(toComparablePath('../../contexts/x/index.js'), 'contexts/x/index.js')
  ok('leading ../ segments stripped')
  assert.equal(toComparablePath('~/.claude/settings.js'), '.claude/settings.js')
  ok('home tilde stripped')
  assert.equal(toComparablePath('a//b///c.ts'), 'a/b/c.ts')
  ok('repeated separators collapsed')
}

// ── fileMentionMatches: the join predicate ──────────────────────────────────
const T = 'bin/ckn-sync.ts' // a real repo-relative edit target

// POSITIVE — real stored shapes that MUST match the repo-relative target
{
  assert.equal(fileMentionMatches('bin/ckn-sync.ts', T), true)
  ok('exact repo-relative matches')
  assert.equal(
    fileMentionMatches('/path/to/cortex/bin/ckn-sync.ts', T),
    true,
  )
  ok('absolute (zwd root) matches via suffix')
  // The cross-machine unification win: the SAME repo file stored under zw1's
  // /home/claude/cortex root must match the same repo-relative target.
  assert.equal(fileMentionMatches('/home/claude/cortex/bin/ckn-sync.ts', T), true)
  ok('absolute (zw1 cross-machine root) matches — unifies fractured copies')
  assert.equal(fileMentionMatches('cortex/bin/ckn-sync.ts', T), true)
  ok('repo-prefixed matches via suffix')
  assert.equal(fileMentionMatches('./app.js', 'app.js'), true)
  ok('cwd-relative ./ matches')
  assert.equal(fileMentionMatches('../../contexts/x/index.js', 'contexts/x/index.js'), true)
  ok('cwd-relative ../ matches')
  assert.equal(fileMentionMatches('server\\graph\\db.ts', 'server/graph/db.ts'), true)
  ok('backslash stored matches POSIX target')
}

// NEGATIVE — precision: no false positives
{
  assert.equal(fileMentionMatches('/x/bin/ckn-name-session.ts', T), false)
  ok('different file does not match')
  // Stored bare basename SHORTER than the target must NOT match — avoids the
  // "db.ts matches every db.ts" false-positive class. Tier-1 favors precision.
  assert.equal(fileMentionMatches('ckn-sync.ts', T), false)
  ok('stored shorter-than-target (bare basename) does not match')
  // Suffix must align on a SEGMENT boundary, not mid-segment.
  assert.equal(fileMentionMatches('/x/foo-bin/ckn-sync.ts', T), false)
  ok('mid-segment suffix does not match (boundary respected)')
  assert.equal(fileMentionMatches('', T), false)
  ok('empty stored path does not match')
  assert.equal(fileMentionMatches(T, ''), false)
  ok('empty target does not match')
}

console.log(`\nOK file-match.test.ts — ${passed} assertions passed`)
