#!/usr/bin/env tsx
/**
 * resolveSelfSessionId — the authoritative self-id resolver (Part 1 of the
 * session-identity / s2s-routing fix). Ground truth = the actively-appended
 * <id>.jsonl whose internal sessionId stamp matches its filename. NEVER a uuid
 * scraped from a tool-results/SessionStart artifact dir (the bootstrap phantom).
 *
 * Repro that motivated this: a continue/compact bootstrap minted a phantom uuid
 * with a tool-results dir + a blank presence but NO transcript; the resolver must
 * pick the real, actively-appended transcript over the phantom even when env/input
 * carry the phantom id.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const { resolveSelfSessionId } = await import('../../bin/_session-id.ts')

const REAL = '11111111-1111-4111-8111-111111111111'
const PHANTOM = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'
const COPY = '44444444-4444-4444-8444-444444444444'

const NOW = 1_700_000_000_000
const MIN = 60_000

/** Build a temp ~/.claude/projects-style root. `transcripts` maps
 *  <encDir>/<uuid> → { stamp, ageMin }; phantomDirs are bare artifact dirs. */
function mkRoot(spec: {
  transcripts?: { dir: string; id: string; stamp?: string; ageMin?: number }[]
  phantomDirs?: { dir: string; id: string }[]
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-selfid-'))
  for (const t of spec.transcripts ?? []) {
    const d = path.join(root, t.dir)
    fs.mkdirSync(d, { recursive: true })
    const file = path.join(d, `${t.id}.jsonl`)
    const stamp = t.stamp ?? t.id
    fs.writeFileSync(file, JSON.stringify({ type: 'summary', sessionId: stamp }) + '\n')
    const mtime = (NOW - (t.ageMin ?? 0) * MIN) / 1000
    fs.utimesSync(file, mtime, mtime)
  }
  for (const p of spec.phantomDirs ?? []) {
    // a tool-results artifact dir at depth 3 — NO <id>.jsonl at depth 2.
    fs.mkdirSync(path.join(root, p.dir, p.id, 'tool-results'), { recursive: true })
    fs.writeFileSync(path.join(root, p.dir, p.id, 'tool-results', 'x.txt'), 'artifact')
  }
  return root
}

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. PHANTOM-BOOTSTRAP: a phantom uuid exists ONLY as a tool-results artifact
//      dir (no transcript) beside a real transcript → resolve to the REAL id.
//      The phantom is structurally excluded (never a depth-2 <uuid>.jsonl).
{
  const root = mkRoot({
    transcripts: [{ dir: 'proj1', id: REAL, ageMin: 0 }],
    phantomDirs: [{ dir: 'proj1', id: PHANTOM }],
  })
  const r = resolveSelfSessionId({ projectsRoot: root }) // no env hint — purest case
  assert.equal(r.sessionId, REAL, 'picks the real transcript; the tool-results phantom dir is ignored')
  assert.notEqual(r.sessionId, PHANTOM, 'never the tool-results phantom uuid')
  ok('phantom-bootstrap: tool-results dir is structurally excluded')
}

// ── 2. NORMAL: env IS the real id and its transcript validates → env wins via
//      transcript; a sibling phantom artifact dir is ignored.
{
  const root = mkRoot({
    transcripts: [{ dir: 'proj1', id: REAL, ageMin: 0 }],
    phantomDirs: [{ dir: 'proj1', id: PHANTOM }],
  })
  const r = resolveSelfSessionId({ env: REAL, input: REAL, projectsRoot: root })
  assert.equal(r.sessionId, REAL, 'env validated by its own transcript')
  assert.equal(r.source, 'transcript', 'source = transcript')
  ok('normal: env validated by its transcript')
}

// ── 3. COPIED TRANSCRIPT: env=COPY but <COPY>.jsonl's internal stamp is OTHER —
//      env is CONTRADICTED → not trusted; fall through to the real transcript.
{
  const root = mkRoot({
    transcripts: [
      { dir: 'proj1', id: REAL, ageMin: 0 },
      { dir: 'proj1', id: COPY, stamp: OTHER, ageMin: 0 }, // mismatched stamp
    ],
  })
  const r = resolveSelfSessionId({ env: COPY, input: COPY, projectsRoot: root })
  assert.notEqual(r.sessionId, COPY, 'a contradicted env (mismatched-stamp transcript) is not trusted')
  assert.equal(r.sessionId, REAL, 'falls through to the real validated transcript')
  ok('contradicted env (copied transcript) is rejected')
}

// ── 4. FRESH SESSION: env is set but its transcript has not flushed yet (no
//      <id>.jsonl) → trust env verbatim (uncontradicted). A bus id is not a uuid.
{
  const root = mkRoot({ transcripts: [{ dir: 'proj1', id: OTHER, ageMin: 90 }] })
  const r = resolveSelfSessionId({ env: 'pg-A-fresh', input: 'pg-A-fresh', projectsRoot: root })
  assert.equal(r.sessionId, 'pg-A-fresh', 'fresh session: uncontradicted env is trusted verbatim')
  assert.equal(r.source, 'env', 'source = env')
  ok('fresh session: uncontradicted env trusted (non-uuid id ok)')
}

// ── 5. EXPLICIT override always wins — verbatim, even a non-uuid id.
{
  const root = mkRoot({ transcripts: [{ dir: 'proj1', id: REAL, ageMin: 0 }] })
  const r = resolveSelfSessionId({ explicit: 'pg-B-123', env: REAL, projectsRoot: root })
  assert.equal(r.sessionId, 'pg-B-123', 'explicit --session/--from wins verbatim')
  assert.equal(r.source, 'explicit', 'source = explicit')
  ok('explicit override wins verbatim')
}

// ── 6. NEWEST-TRANSCRIPT fallback: no env/input; pick the newest validated
//      transcript across ALL project dirs (cwd-elsewhere sessions included).
{
  const root = mkRoot({
    transcripts: [
      { dir: 'projA', id: REAL, ageMin: 10 },
      { dir: 'projB', id: OTHER, ageMin: 1 }, // newer
    ],
  })
  const r = resolveSelfSessionId({ projectsRoot: root })
  assert.equal(r.sessionId, OTHER, 'newest validated transcript across all dirs')
  assert.equal(r.source, 'newest-transcript', 'source = newest-transcript')
  ok('newest-transcript fallback globs all project dirs')
}

console.log(`\nOK resolve-self-session.test.ts — ${passed} assertions passed`)
