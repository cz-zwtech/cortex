#!/usr/bin/env tsx
/**
 * #85 canonical transcript-dir resolver (bin/_session-id.ts).
 *
 * The bug: every transcript-resolution site hand-rolled `encode(cwd)` and assumed
 * the cwd it was handed IS the project root that names ~/.claude/projects/<enc>.
 * A session cwd is often a SUBDIR of that root (live: transcript dir
 * -mnt-e-Repos-personal, cwd .../personal/<subdir>), so each site resolved the
 * WRONG dir, found no transcript, returned an empty title.
 *
 * Cure = projectDirForSession(sid,cwd) ordered chain:
 *   1. glob-by-sid: the dir that actually CONTAINS <sid>.jsonl — AUTHORITATIVE,
 *      beats any same-named existing dir (the subdir-cwd repro).
 *   2. ancestor-walk DEEPEST-FIRST: most-specific existing projects/<enc> dir.
 *   3. raw-encode last resort.
 * projectDirForCwd(cwd) = steps 2+3 (the pre-transcript write-path heuristic).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { projectDirForSession, projectDirForCwd } = await import('../bin/_session-id.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// Independent encoding oracle — the test must not borrow the impl's encoder.
const enc = (p: string): string => p.replace(/[/\\:]/g, '-')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-projdir-'))
const projectsRoot = path.join(tmp, 'projects')
fs.mkdirSync(projectsRoot, { recursive: true })

const mkdir = (e: string): void => {
  fs.mkdirSync(path.join(projectsRoot, e), { recursive: true })
}
const writeTranscript = (e: string, id: string): void => {
  const dir = path.join(projectsRoot, e)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ sessionId: id, type: 'x' }) + '\n')
}

// ── A. subdir-cwd repro: transcript lives under encode(root); cwd is a SUBDIR.
//      A same-named encode(subdir) dir ALSO exists as a decoy — step-1 must WIN.
{
  const root = '/work/space/proj'
  const subdir = '/work/space/proj/pkg/app'
  const sid = '11111111-2222-3333-4444-555555555555'
  writeTranscript(enc(root), sid) // the real transcript dir
  mkdir(enc(subdir)) // decoy: an existing dir matching the subdir cwd
  const got = projectDirForSession(sid, subdir, projectsRoot)
  assert.equal(
    got,
    path.join(projectsRoot, enc(root)),
    'glob-by-sid returns the transcript dir, not the encoded subdir cwd',
  )
  ok('A: subdir-cwd resolves to the dir that CONTAINS the transcript (step 1 authoritative)')
}

// ── B. tie determinism (step 2, NO transcript): both subdir + parent dirs exist
//      → deepest/most-specific wins, deterministically.
{
  const parent = '/tie/parent'
  const child = '/tie/parent/child'
  mkdir(enc(parent))
  mkdir(enc(child))
  const noSid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const got = projectDirForSession(noSid, child, projectsRoot)
  assert.equal(
    got,
    path.join(projectsRoot, enc(child)),
    'deepest-ancestor-first: most-specific existing dir wins',
  )
  ok('B: tie (subdir + parent both exist, no transcript) → deepest wins, deterministic')
}

// ── C. raw-encode last resort: nothing exists for cwd or sid.
{
  const lonely = '/no/such/place'
  const noSid = 'ffffffff-0000-1111-2222-333333333333'
  const got = projectDirForSession(noSid, lonely, projectsRoot)
  assert.equal(
    got,
    path.join(projectsRoot, enc(lonely)),
    'no transcript + no existing ancestor dir → raw-encode cwd',
  )
  ok('C: no transcript + no existing dir → raw-encode fallback')
}

// ── D. projectDirForCwd in isolation: deepest-first existing, else raw-encode.
{
  const parent = '/d/only/parent'
  const leaf = '/d/only/parent/leaf'
  mkdir(enc(parent)) // only the parent dir exists; leaf does not
  assert.equal(
    projectDirForCwd(leaf, projectsRoot),
    path.join(projectsRoot, enc(parent)),
    'walks up to the nearest existing ancestor dir',
  )
  assert.equal(
    projectDirForCwd('/d/none/here', projectsRoot),
    path.join(projectsRoot, enc('/d/none/here')),
    'no ancestor exists → raw-encode',
  )
  ok('D: projectDirForCwd deepest-first existing, raw-encode fallback')
}

// ── E. normal (non-subdir) case unchanged: cwd IS the transcript root.
{
  const root = '/normal/root'
  const id = '99999999-8888-7777-6666-555555555555'
  writeTranscript(enc(root), id)
  assert.equal(
    projectDirForSession(id, root, projectsRoot),
    path.join(projectsRoot, enc(root)),
    'cwd == transcript root → same dir (no regression)',
  )
  ok('E: normal cwd==root case unchanged')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} assertions passed.`)
process.exit(0)
