#!/usr/bin/env tsx
/**
 * s3 — the acted-on detector (pure function, NO materialized ACTED_ON_IN edge).
 *
 * D1: actedOn(M,S) iff  M --SURFACED_IN--> S  AND  ∃ file F:
 *     M --MENTIONS_FILE--> F_prose  AND  F_edit --EDITED_IN--> S  where the two
 *     file nodes' verbatim paths pathSuffixMatch (the r3 join).
 *
 * The r3 crux the gate scrutinizes: MENTIONS_FILE stores prose paths VERBATIM
 * (relative/partial, fileMentions.ts) while EDITED_IN stores the ABSOLUTE
 * transcript path — DIFFERENT file nodes, DIFFERENT ids. Bridging them by
 * id-equality is impossible without a repo-root registry (breaks cross-machine +
 * deleted files), so the join is a /-boundary suffix match over the nodes' names
 * with a ≥2-segment specificity floor (kills the bare-basename collision class).
 * The JOIN test below MUST use a real mismatched pair (relative prose + absolute
 * edit, same file) — a same-form pair would pass here while prod silently fails.
 *
 * Temp-DB pattern mirrors test/graph/surfacings.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-actedon-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run, get } = await import('../../server/graph/db.ts')
const { fileEntryId, ensureStubEntry } = await import('../../server/graph/sync.ts')
const { recordSurfacings } = await import('../../server/graph/surfacings.ts')
const { recordEditedIn } = await import('../../server/graph/editedIn.ts')
const { actedOn, actedOnReport, reinforcementFor, pathSuffixMatch } = await import('../../server/graph/actedOn.ts')

getDb()

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// Seed a memory→file MENTIONS_FILE edge with a VERBATIM (here: relative/partial)
// prose path — mirrors §5.3: file stub id = fileEntryId(path), name = verbatim path.
const seedMention = (memId: string, prosePath: string) => {
  ensureStubEntry(null, memId, memId, 'memory', 'user')
  const fid = fileEntryId(prosePath)
  ensureStubEntry(null, fid, prosePath, 'file', 'file')
  run(`INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, 'MENTIONS_FILE')`, memId, fid)
}

const ABS = '/path/to/cortex/server/graph/sync.ts'

// ── pathSuffixMatch — pure, no DB ─────────────────────────────────────────────
{
  // positive: relative prose is a ≥2-seg /-boundary suffix of the absolute edit path
  assert.equal(pathSuffixMatch('server/graph/sync.ts', ABS), true, 'relative ⊂ absolute (3-seg) matches')
  assert.equal(pathSuffixMatch('graph/sync.ts', ABS), true, '2-seg suffix matches (at the floor)')
  // bare basename = 1 segment → never matches (the collision class PM flagged)
  assert.equal(pathSuffixMatch('sync.ts', ABS), false, 'bare basename (1-seg) is below the floor')
  // 2-seg overlap but the segments differ → no match
  assert.equal(pathSuffixMatch('other/sync.ts', '/x/graph/sync.ts'), false, '2-seg mismatch rejected')
  // separator normalization (PM refinement 1): Windows backslash prose vs WSL edit
  assert.equal(pathSuffixMatch('server\\graph\\sync.ts', ABS), true, 'backslash prose normalizes to match')
  // identical absolute paths (prose-absolute == edit-absolute) match exactly
  assert.equal(pathSuffixMatch(ABS, ABS), true, 'identical absolute paths match')
  ok('pathSuffixMatch: /-boundary suffix, ≥2-seg floor, separator-normalized')
}

// ── KNOWN-ACCEPTED margin (PM refinement 2) — do NOT "fix" into over-strictness ─
// A common 2-seg suffix can match the WRONG file in a monorepo. This corroborates
// only when that wrong file is ALSO edited in the SAME session M surfaced in — a
// narrow conjunction, and corroborate-not-authorize tolerates a miss. 2 is the
// right floor (3 would kill too many true 2-seg prose matches). Asserted as
// KNOWN-ACCEPTED so a future reader doesn't tighten it.
{
  assert.equal(
    pathSuffixMatch('src/index.ts', '/repo/pkgB/src/index.ts'),
    true,
    'KNOWN-ACCEPTED: a 2-seg suffix can over-match across packages (tolerated, not a bug)',
  )
  ok('pathSuffixMatch: 2-seg monorepo over-match is KNOWN-ACCEPTED')
}

// ── D1 positive — the real mismatched-pair JOIN (the gate's hardest test) ─────
{
  seedMention('mem:1', 'server/graph/sync.ts')          // relative prose
  recordEditedIn('sess:1', [{ path: ABS, count: 1, firstAt: 100, lastAt: 200 }]) // absolute edit
  recordSurfacings('sess:1', ['mem:1'], 50)             // surfaced in the same session
  assert.equal(
    actedOn('mem:1', 'sess:1'),
    true,
    'D1: surfaced + (relative-prose mention ⋈ absolute-edit, same file) ⇒ acted-on',
  )
  ok('actedOn D1: relative-prose ⋈ absolute-edit join corroborates')
}

// ── negative — not surfaced in the session (D1 requires SURFACED_IN) ──────────
{
  seedMention('mem:2', 'server/graph/sync.ts')
  recordEditedIn('sess:2', [{ path: ABS, count: 1, firstAt: 100, lastAt: 200 }])
  // no recordSurfacings for mem:2 → sess:2
  assert.equal(actedOn('mem:2', 'sess:2'), false, 'mention+edit but never surfaced ⇒ NOT acted-on')
  ok('actedOn: no SURFACED_IN ⇒ false')
}

// ── negative — mentioned file is NOT the edited file (no suffix match) ────────
{
  seedMention('mem:3', 'server/graph/threads.ts')       // mentions a DIFFERENT file
  recordEditedIn('sess:3', [{ path: ABS, count: 1, firstAt: 100, lastAt: 200 }]) // edited sync.ts
  recordSurfacings('sess:3', ['mem:3'], 50)
  assert.equal(actedOn('mem:3', 'sess:3'), false, 'surfaced but the edited file isn\'t the one mentioned ⇒ false')
  ok('actedOn: mentioned ≠ edited ⇒ false')
}

// ── negative — basename-only overlap is below the floor (no false corroboration) ─
{
  seedMention('mem:4', 'sync.ts')                       // bare basename prose (1-seg)
  recordEditedIn('sess:4', [{ path: ABS, count: 1, firstAt: 100, lastAt: 200 }])
  recordSurfacings('sess:4', ['mem:4'], 50)
  assert.equal(actedOn('mem:4', 'sess:4'), false, 'bare-basename mention cannot corroborate (1-seg < floor)')
  ok('actedOn: basename-only mention ⇒ false (specificity floor holds end-to-end)')
}

// ── KNOWN-ACCEPTED monorepo over-match at the DB level (documents the margin) ──
{
  seedMention('mem:5', 'src/index.ts')                  // 2-seg prose
  recordEditedIn('sess:5', [{ path: '/repo/pkgB/src/index.ts', count: 1, firstAt: 100, lastAt: 200 }])
  recordSurfacings('sess:5', ['mem:5'], 50)
  assert.equal(
    actedOn('mem:5', 'sess:5'),
    true,
    'KNOWN-ACCEPTED: a 2-seg prose suffix corroborates a same-suffix edit in the surfaced session',
  )
  ok('actedOn: monorepo 2-seg over-match corroborates (KNOWN-ACCEPTED, tolerated)')
}

// ── D3 (afterSurface) — causal time-order: lastEditAt >= firstSurfacedAt ───────
// Opt-in tightening (default actedOn stays D1). The edit must be at/after the
// memory was FIRST surfaced (surfaced THEN acted). MUST use SURFACED_IN.firstAt,
// not notedAt (lastSurfacedAt) — the lastAt-inversion regression below pins it.
{
  seedMention('mem:d3', 'server/graph/sync.ts')
  recordSurfacings('sess:d3', ['mem:d3'], 100)                                 // firstSurfacedAt = 100
  recordEditedIn('sess:d3', [{ path: ABS, count: 1, firstAt: 300, lastAt: 300 }]) // edit at 300 (after)
  recordSurfacings('sess:d3', ['mem:d3'], 500)                                 // re-surface: lastAt=500, firstAt STAYS 100
  assert.equal(actedOn('mem:d3', 'sess:d3'), true, 'D1 base still true')
  assert.equal(
    actedOn('mem:d3', 'sess:d3', { afterSurface: true }),
    true,
    'D3: edit(300) >= firstSurfacedAt(100) — and a later re-surface(500) must NOT flip it false (firstAt, not lastAt)',
  )
  ok('D3: acted-on-after-surface true; lastAt-inversion regression (uses firstSurfacedAt)')
}
{
  seedMention('mem:d3b', 'server/graph/sync.ts')
  recordSurfacings('sess:d3b', ['mem:d3b'], 400)                               // firstSurfacedAt = 400
  recordEditedIn('sess:d3b', [{ path: ABS, count: 1, firstAt: 100, lastAt: 100 }]) // edit at 100 (BEFORE)
  assert.equal(actedOn('mem:d3b', 'sess:d3b'), true, 'D1: mention+edit+surface present → true')
  assert.equal(
    actedOn('mem:d3b', 'sess:d3b', { afterSurface: true }),
    false,
    'D3: edit(100) < firstSurfacedAt(400) → not acted-on-AFTER-surface (causal order enforced)',
  )
  ok('D3: an edit BEFORE the first surfacing does not corroborate (afterSurface)')
}

// ── reinforcementFor — the strongest acted-on badge across M's surfaced sessions ─
// s4 reads this both to EXEMPT acted-on memories from decay and to BADGE which
// reinforcement fired (D3 causal > D1 co-occurrence > none) in the review surface.
{
  assert.equal(reinforcementFor('mem:d3'), 'D3', 'edit after first surface → D3 (causal) badge')
  assert.equal(reinforcementFor('mem:d3b'), 'D1', 'edit before surface but co-occurs → D1 (co-occurrence) badge')
  assert.equal(reinforcementFor('mem:3'), null, 'surfaced but mentioned≠edited → no reinforcement')
  assert.equal(reinforcementFor('mem:nope'), null, 'never surfaced → no reinforcement')
  ok('reinforcementFor: strongest badge D3 > D1 > null across surfaced sessions')
}

// ── corroborate-not-authorize — the detector is READ-ONLY (no writes, no gating) ─
// s3 is a SIGNAL: it must never mutate the graph or gate recall. Assert a call
// changes neither edge nor entry counts (a write would be the first step toward
// authorization).
{
  const edgesBefore = get<{ c: number }>(`SELECT count(*) c FROM edges`)!.c
  const entriesBefore = get<{ c: number }>(`SELECT count(*) c FROM entries`)!.c
  actedOn('mem:1', 'sess:1')
  actedOn('mem:nope', 'sess:nope')
  assert.equal(get<{ c: number }>(`SELECT count(*) c FROM edges`)!.c, edgesBefore, 'no edges written')
  assert.equal(get<{ c: number }>(`SELECT count(*) c FROM entries`)!.c, entriesBefore, 'no entries written')
  ok('actedOn: read-only — corroborate, never authorize (no graph writes)')
}

// ── actedOnReport — read-only inspection backing the debug verb ───────────────
{
  const rep = actedOnReport('mem:1') // surfaced in sess:1, acted-on
  const s1 = rep.find((r) => r.session === 'sess:1')
  assert.ok(s1, 'reports the surfaced session')
  assert.equal(s1!.acted, true, 'sess:1 is acted-on')
  assert.equal(s1!.matches.length, 1, 'one corroborating file pair')
  assert.equal(s1!.matches[0]!.mentioned, 'server/graph/sync.ts', 'reports the verbatim prose path')
  assert.ok(s1!.matches[0]!.edited.endsWith('/server/graph/sync.ts'), 'reports the edited (absolute) path')
  ok('actedOnReport: lists surfaced sessions + corroborating files (acted)')
}
{
  const rep = actedOnReport('mem:3') // surfaced in sess:3 but mentioned ≠ edited
  const s3 = rep.find((r) => r.session === 'sess:3')
  assert.ok(s3, 'reports the surfaced session')
  assert.equal(s3!.acted, false, 'sess:3 surfaced but not acted-on')
  assert.equal(s3!.matches.length, 0, 'no corroborating files')
  ok('actedOnReport: surfaced-but-not-acted reported with acted=false')
}

console.log(`\nOK acted-on.test.ts — ${passed} cases passed`)
