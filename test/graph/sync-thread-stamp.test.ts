#!/usr/bin/env tsx
/**
 * s2a #32 — cortex-snapshot write-discipline / anti-hollow guard (sync half).
 *
 * A thread is a graph entry with kind='thread' whose STRUCTURED state
 * (status/next_step/links/repo/branch/pushed) lives in `content` as JSON
 * (parseThreadState reads it). But the normal sync path writes the markdown
 * BODY into `content` — so a thread-kind .md synced as-is yields a HOLLOW node:
 * parseThreadState fails to JSON.parse the prose and falls back to empty
 * next_step. That is exactly the anti-hollow failure the litmus must catch.
 *
 * Fix: for kind==='thread', the sync serializes the thread FRONTMATTER fields
 * into content JSON (the body stays human prose). This test is the guard — a
 * snapshot-shaped thread file MUST sync into a non-hollow, resumable thread node.
 *
 * End-to-end against a temp $HOME, mirroring sync-port.test.ts's disk-sync block.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dbdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-threadstamp-db-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dbdir, 'graph.sqlite')
process.env.HOME = dbdir

const { getDb, run, get } = await import('../../server/graph/db.js')
const sync = await import('../../server/graph/sync.js')
const { getThread, resumableThreads, claimThread, threadClaimState } = await import(
  '../../server/graph/threads.js'
)
getDb()

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-threadstamp-home-'))
const memDir = path.join(home, '.claude', 'memory')
fs.mkdirSync(memDir, { recursive: true })

// A snapshot-shaped thread file: structured state in frontmatter, prose body.
fs.writeFileSync(
  path.join(memDir, 'resume-thread.md'),
  [
    '---',
    'id: thread:resume-x',
    'name: Resume X',
    'type: thread',
    'description: in-flight resume surface work',
    'status: in-progress',
    'next_step: wire the anti-hollow guard then ship s2b',
    'links:',
    '  - cortex-s2-build-state',
    '  - cortex-thread-kind-ratified-design',
    'repo: cortex',
    'branch: master',
    'pushed: true',
    'machine: box-A',
    '---',
    'Human-readable narrative about what this thread is. Not the state — that lives',
    'in the frontmatter above and is what /cortex-continue reads.',
    '',
  ].join('\n'),
  'utf8',
)
// A hollow thread file: declares the kind but NO next_step — the failure shape.
fs.writeFileSync(
  path.join(memDir, 'hollow-thread.md'),
  ['---', 'id: thread:hollow', 'name: Hollow', 'type: thread', '---', 'no state declared', ''].join('\n'),
  'utf8',
)
// A NORMALIZED MEMORY file: same nested shape, but metadata.type is a memory
// SUBTYPE (project), NOT a graph kind. It MUST stay kind='memory' — the
// disambiguation guard (only `thread` promotes from metadata) protects this.
fs.writeFileSync(
  path.join(memDir, 'normalized-memory.md'),
  [
    '---',
    'id: mem:normalized-proj',
    'name: Normalized Memory',
    'description: a normal project memory in the nested shape',
    'metadata:',
    '  node_type: memory',
    '  type: project',
    '---',
    'body',
    '',
  ].join('\n'),
  'utf8',
)
// REAL normalizer output (byte-for-byte the shape of the ground-truth repro
// ~/.claude/projects/-mnt-e-Repos-personal/memory/thread-cortex-memory-build.md):
// node_type FORCED to memory, type preserved, AND id + machine + state ALL nested
// under metadata. The unit fixtures above used a top-level id; this one proves
// the id and owner survive when the normalizer nests them too.
fs.writeFileSync(
  path.join(memDir, 'thread-pipeline.md'),
  [
    '---',
    'name: cortex-memory-build',
    'description: the resume-surface build thread',
    'metadata: ',
    '  node_type: memory',
    '  id: thread:pipeline-x',
    '  type: thread',
    '  status: in-progress',
    '  next_step: "Run the cross-session litmus from a fresh session"',
    '  links: ',
    '    - cortex-memory-one-mind-use-case',
    '  repo: claude-config-dashboard',
    '  branch: master',
    '  pushed: true',
    '  machine: node-a-c5e3af1c',
    '  originSessionId: 6d56cecc-b8ad-48f0-9bc5-12209fbd6adf',
    '---',
    'Narrative body.',
    '',
  ].join('\n'),
  'utf8',
)
// A NORMALIZED thread file: the external memory-frontmatter normalizer rewrites
// the authored top-level `type: thread` + thread fields into the canonical
// `metadata: {node_type: memory, type: thread, ...}` nested shape. This is the
// litmus bug 6d56cecc caught — both the kind AND the structured state land under
// `metadata`, so the thread synced as a hollow MEMORY and /cortex-threads = [].
fs.writeFileSync(
  path.join(memDir, 'normalized-thread.md'),
  [
    '---',
    'id: thread:normalized-x',
    'name: Normalized X',
    'description: normalized in-flight work',
    'metadata:',
    '  node_type: memory',
    '  type: thread',
    '  status: blocked',
    '  next_step: unblock the deploy gate',
    '  links:',
    '    - some-detail-memory',
    '  repo: cortex',
    '  branch: master',
    '  pushed: false',
    '---',
    'prose body — the structured state is nested under metadata above.',
    '',
  ].join('\n'),
  'utf8',
)

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

await sync.syncMemories(home)

// ── 1. a snapshot-shaped thread file syncs into a NON-hollow thread node
{
  const t = getThread('thread:resume-x')
  assert.ok(t, 'thread node created')
  assert.equal(t!.state.status, 'in-progress', 'status stamped from frontmatter')
  assert.equal(t!.state.nextStep, 'wire the anti-hollow guard then ship s2b', 'next_step stamped (NOT hollow)')
  assert.deepEqual(t!.state.links, ['cortex-s2-build-state', 'cortex-thread-kind-ratified-design'], 'links stamped')
  assert.equal(t!.state.repo, 'cortex', 'repo stamped')
  assert.equal(t!.state.branch, 'master', 'branch stamped')
  assert.equal(t!.state.pushed, true, 'pushed stamped')
  assert.equal(t!.ownerMachine, 'box-A', 'owner machine from frontmatter')
  assert.equal(t!.description, 'in-flight resume surface work', 'one-line summary preserved')
  ok('snapshot-shaped thread file → non-hollow resumable thread node')
}

// ── 2. the body is NOT what ends up in the structured state (state is frontmatter-derived)
{
  const t = getThread('thread:resume-x')
  assert.ok(!t!.state.nextStep.includes('narrative'), 'prose body did not leak into next_step')
  ok('thread state is frontmatter-derived, not body-derived')
}

// ── 3. a hollow thread file (no next_step) is detectable as hollow (empty next_step)
{
  const t = getThread('thread:hollow')
  assert.ok(t, 'hollow thread still a node')
  assert.equal(t!.state.nextStep, '', 'no next_step → empty (the litmus FAILS on this — guard target)')
  ok('hollow thread node has empty next_step (anti-hollow guard can detect it)')
}

// ── 3b. the NORMALIZED thread shape (type + state nested under metadata) still
//       syncs into a non-hollow thread node — the bug the litmus caught.
{
  const t = getThread('thread:normalized-x')
  assert.ok(t, 'normalized thread is a thread node (kind derived from metadata.type)')
  assert.equal(t!.state.status, 'blocked', 'status read from nested metadata')
  assert.equal(t!.state.nextStep, 'unblock the deploy gate', 'next_step read from nested metadata (NOT hollow)')
  assert.deepEqual(t!.state.links, ['some-detail-memory'], 'links read from nested metadata')
  assert.equal(t!.state.repo, 'cortex', 'repo from nested metadata')
  assert.equal(t!.state.pushed, false, 'pushed from nested metadata')
  ok('normalized (metadata-nested) thread syncs into a non-hollow thread node')
}

// ── 3bb. REAL-NORMALIZER-OUTPUT (live-pipeline shape): node_type forced to
//        memory, id + machine + state ALL nested under metadata → still a
//        non-hollow thread with the intended id + owner.
{
  const t = getThread('thread:pipeline-x')
  assert.ok(t, 'thread surfaces under its nested metadata.id despite node_type:memory')
  assert.equal(t!.state.nextStep, 'Run the cross-session litmus from a fresh session', 'next_step intact (not hollow)')
  assert.equal(t!.state.status, 'in-progress', 'status from nested metadata')
  assert.equal(t!.state.pushed, true, 'pushed from nested metadata')
  assert.equal(t!.ownerMachine, 'node-a-c5e3af1c', 'owner machine read from nested metadata.machine')
  ok('real-normalizer-output thread: id + owner + next_step survive node_type:memory')
}

// ── 3c. REGRESSION: a normalized MEMORY (metadata.type=project, a SUBTYPE) must
//       NOT be promoted to a 'project' kind — it stays kind='memory'.
{
  const row = get<{ kind: string }>(`SELECT kind FROM entries WHERE id = 'mem:normalized-proj'`)
  assert.ok(row, 'normalized memory entry exists')
  assert.equal(row!.kind, 'memory', "metadata.type=project (a subtype) stays kind='memory', not 'project'")
  assert.equal(getThread('mem:normalized-proj'), null, 'a normalized memory is never a thread')
  ok('normalized memory keeps kind=memory (subtype not promoted)')
}

// ── 4. THE LITMUS: a fresh session (no --resume) resumes the synced thread via
//      the graph — sees it as a pending resume candidate, claims it, reads the
//      next_step. This is the end-to-end s2 acceptance.
{
  const NOW = 1_700_000_000_000
  const fresh = 'fresh-session-no-resume'
  // A real resuming session registers presence on the bus at SessionStart — a
  // claim only counts while its session is present (live|idle), so the fixture
  // mirrors that with a live session_meta row.
  run(`INSERT INTO session_meta (id, last_seen, status) VALUES (?, ?, '')`, fresh, NOW)
  const candidates = resumableThreads(fresh, NOW)
  const target = candidates.find((t) => t.id === 'thread:resume-x')
  assert.ok(target, 'fresh session finds the synced thread as a resume candidate')
  assert.equal(target!.claimState, 'pending', 'unclaimed synced thread is pending for the fresh session')
  assert.equal(target!.state.nextStep, 'wire the anti-hollow guard then ship s2b', 'next_step is readable for resume')
  claimThread('thread:resume-x', fresh, NOW)
  assert.equal(threadClaimState('thread:resume-x', fresh, NOW), 'claimed-mine', 'fresh session now holds the claim')
  ok('LITMUS: fresh session resumes a synced thread (no --resume) via the graph')
}

console.log(`\nOK sync-thread-stamp.test.ts — ${passed} assertions passed`)
