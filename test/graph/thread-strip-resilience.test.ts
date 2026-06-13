#!/usr/bin/env tsx
/**
 * Thread-strip RESILIENCE (TASK#1 — the close of the thread-frontmatter-strip bug).
 *
 * Root cause: the strip originates OUTSIDE Cortex (no Cortex serializer produces
 * the corrupted bytes — serializeMemory provably preserves the metadata block).
 * The FILE is an exchange surface any writer (a peer LLM tidying frontmatter to
 * the harness's name/description/metadata.type/body shape) can mangle. So the fix
 * lives at the sync chokepoint, NOT in a serializer: a thread, once established,
 * must SURVIVE its backing file being found stripped, and the file must be HEALED
 * back from the graph entry (the file is the private-mind carrier — a poisoned
 * file would mind-sync DEAD to a fresh laptop graph that has nothing to preserve
 * from). Same defensive family as the anti-hollow litmus + s1 OBSERVATIONAL_RELS.
 *
 * The trigger keys off `entries.source` (the file path), NOT the frontmatter id —
 * source is the stable link that survives even when the strip drops the id. That
 * one trigger covers BOTH strip shapes: id-INTACT (would overwrite the good entry)
 * and id-DROPPED (would spawn a dead path-derived dup that shadows the thread).
 *
 * Temp-DB + on-disk memory pattern; real syncMemories, embeddings off.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-thread-strip-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const memDir = path.join(dir, '.claude', 'memory')
fs.mkdirSync(memDir, { recursive: true })

const { getDb, get, run } = await import('../../server/graph/db.ts')
const { syncMemories, threadHealCount } = await import('../../server/graph/sync.ts')
const { getThread, resumableThreads } = await import('../../server/graph/threads.ts')
const { parse } = await import('../../src/adapters/frontmatter.ts')

getDb()

const BODY = 'Human prose body for the thread — survives the round-trip.'
const file = (slug: string) => path.join(memDir, `${slug}.md`)

// A healthy authored thread (the /cortex-snapshot shape: node_type+type, state
// nested under metadata, id present).
const writeGoodThread = (slug: string, id: string, nextStep: string) =>
  fs.writeFileSync(
    file(slug),
    [
      '---',
      `name: ${slug}`,
      'description: a test thread anchor',
      'metadata:',
      '  node_type: thread',
      `  id: ${id}`,
      '  type: thread',
      '  status: in-progress',
      `  next_step: "${nextStep}"`,
      '  links:',
      '    - link-detail-a',
      '    - link-detail-b',
      '  repo: claude-config-dashboard',
      '  branch: master',
      '  pushed: true',
      '---',
      '',
      BODY,
      '',
    ].join('\n'),
  )

// The corrupted exchange-surface shape (ground truth: the real mem_log dup) —
// name emptied, metadata collapsed to node_type:memory, all thread state gone.
// `keepIdTopLevel` toggles the two real shapes: id-INTACT (a top-level id maps to
// the same entry id → would overwrite) vs id-DROPPED (path-derived dup → shadow).
const writeStripped = (slug: string, id: string, keepIdTopLevel: boolean) =>
  fs.writeFileSync(
    file(slug),
    [
      '---',
      'name: ""',
      ...(keepIdTopLevel ? [`id: ${id}`] : []),
      'metadata:',
      '  node_type: memory',
      '  originSessionId: 411f5f18-0229-45cb-a437-5c37b7003b7f',
      '---',
      '',
      BODY,
      '',
    ].join('\n'),
  )

const deadDupForFile = (slug: string) =>
  get<{ id: string }>(`SELECT id FROM entries WHERE source = ? AND kind != 'thread'`, file(slug))

const edgeCountForId = (id: string) =>
  (get<{ c: number }>(`SELECT count(*) c FROM edges WHERE src = ? OR dst = ?`, id, id) as { c: number }).c

// Seed a dead-memory dup at a thread's source WITH stale edges (in + out) — the
// real incident's dups each carried 7 stale-derived outbound edges.
const seedDupWithEdges = (slug: string, dupId: string) => {
  run(
    `INSERT INTO entries
       (id, name, kind, description, content, source, scope, updatedAt, syncedAt, authorship,
        outcome, outcome_text, agent_id, session_id, pinned, engagement, machine, content_hash)
       VALUES (?, '', 'memory', '', '', ?, 'user', 0, 0, 'auto-extracted', '', '', '', '', 0, 0, '', '')`,
    dupId,
    file(slug),
  )
  run(`INSERT INTO edges (src, dst, rel) VALUES (?, 'file:some_stale_path', 'MENTIONS_FILE')`, dupId)
  run(`INSERT INTO edges (src, dst, rel) VALUES ('some-other-memory', ?, 'LINKS_TO')`, dupId)
}

const fileIsThread = (slug: string): { thread: boolean; nextStep: string } => {
  const d = parse(fs.readFileSync(file(slug), 'utf8')).data as any
  const meta = d.metadata ?? {}
  const thread = meta.node_type === 'thread' || meta.type === 'thread' || d.node_type === 'thread'
  return { thread, nextStep: String(meta.next_step ?? d.next_step ?? '') }
}

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── A. strip with the id INTACT (the catastrophic overwrite shape) ────────────
{
  const slug = 'thread-a'
  const id = 'thread:surv-a'
  writeGoodThread(slug, id, 'do the important A thing')
  await syncMemories(dir)
  assert.equal(getThread(id)?.state.nextStep, 'do the important A thing', 'A: good thread synced')

  writeStripped(slug, id, /*keepIdTopLevel*/ true)
  await syncMemories(dir)

  const t = getThread(id)
  assert.ok(t, 'A: thread SURVIVES an id-intact strip (not downgraded to a dead memory)')
  assert.equal(t!.state.nextStep, 'do the important A thing', 'A: next_step preserved')
  assert.equal(deadDupForFile(slug), undefined, 'A: no dead memory entry for the file')

  const healed = fileIsThread(slug)
  assert.ok(healed.thread, 'A: file HEALED back to a thread on disk')
  assert.equal(healed.nextStep, 'do the important A thing', 'A: healed file carries next_step')

  const resumable = resumableThreads('some-session', Date.now()).some((r) => r.id === id)
  assert.ok(resumable, 'A: surviving thread is back on the resume surface')
  ok('id-intact strip → thread preserved + file healed + resumable')
}

// ── B. strip with the id DROPPED (the real-incident path-derived-dup shape) ────
{
  const slug = 'thread-b'
  const id = 'thread:surv-b'
  writeGoodThread(slug, id, 'do the important B thing')
  await syncMemories(dir)
  assert.equal(getThread(id)?.state.nextStep, 'do the important B thing', 'B: good thread synced')

  writeStripped(slug, id, /*keepIdTopLevel*/ false)
  await syncMemories(dir)

  const t = getThread(id)
  assert.ok(t, 'B: thread SURVIVES an id-dropped strip')
  assert.equal(t!.state.nextStep, 'do the important B thing', 'B: next_step preserved')
  assert.equal(deadDupForFile(slug), undefined, 'B: no path-derived dead dup shadows the thread')

  const healed = fileIsThread(slug)
  assert.ok(healed.thread, 'B: file HEALED back to a thread on disk')
  ok('id-dropped strip → thread preserved + dead-dup cleaned + file healed')
}

// ── C. heal is IDEMPOTENT: re-syncing a healed file does not re-heal ──────────
{
  const slug = 'thread-b'
  const id = 'thread:surv-b'
  const healCountBefore = threadHealCount()
  const bytesBefore = fs.readFileSync(file(slug), 'utf8')
  await syncMemories(dir)
  const bytesAfter = fs.readFileSync(file(slug), 'utf8')
  assert.equal(bytesAfter, bytesBefore, 'C: healed file is byte-stable across a re-sync (no churn)')
  assert.equal(threadHealCount(), healCountBefore, 'C: no second heal fired (idempotent)')
  assert.equal(getThread(id)?.state.nextStep, 'do the important B thing', 'C: thread still intact')
  ok('heal idempotent — healthy thread re-syncs as a no-op')
}

// ── D. NARROW trigger: a legit full-frontmatter update is NOT a strip ─────────
{
  const slug = 'thread-d'
  const id = 'thread:surv-d'
  writeGoodThread(slug, id, 'next-step v1')
  await syncMemories(dir)
  assert.equal(getThread(id)?.state.nextStep, 'next-step v1', 'D: v1 synced')

  writeGoodThread(slug, id, 'next-step v2') // healthy update, full frontmatter
  await syncMemories(dir)
  assert.equal(
    getThread(id)?.state.nextStep,
    'next-step v2',
    'D: a legit update is applied, NOT frozen by the strip guard',
  )
  ok('narrow trigger — healthy snapshot update is not mistaken for a strip')
}

// ── E. r5: a pre-existing dead-memory dup at the thread's source is CLEANED ────
{
  const slug = 'thread-e'
  const id = 'thread:surv-e'
  writeGoodThread(slug, id, 'do the important E thing')
  await syncMemories(dir)

  // Simulate legacy pollution: a strip BEFORE this fix shipped left a dead memory
  // entry at the thread's source (path-derived id, kind=memory) WITH stale edges.
  const dupId = `dead-dup-${slug}`
  seedDupWithEdges(slug, dupId)
  assert.ok(deadDupForFile(slug), 'E: legacy dead dup seeded at the source')
  assert.ok(edgeCountForId(dupId) >= 2, 'E: dup carries stale edges (in + out)')

  writeStripped(slug, id, /*keepIdTopLevel*/ false)
  await syncMemories(dir)

  assert.ok(getThread(id), 'E: thread survives the strip')
  assert.equal(deadDupForFile(slug), undefined, 'E: pre-existing dead dup cleaned by the heal (r5)')
  assert.equal(edgeCountForId(dupId), 0, 'E: swept dup leaves NO dangling edges (genuine removal)')
  ok('r5 — a legacy dead dup + its dangling edges are cleaned on heal')
}

// ── F. r5-widening (Fable): a HEALTHY thread re-sync sweeps dead dups at source ─
// The structural close of the dup class: any dup a prior strip left behind is
// cleaned on the NEXT healthy sync of that thread file — no orphan-sweep pass, no
// admin endpoint. (The real-incident live rows self-clean this way once the file
// next changes.)
{
  const slug = 'thread-f'
  const id = 'thread:surv-f'
  writeGoodThread(slug, id, 'do the important F thing')
  await syncMemories(dir)

  // legacy dup at the source (a strip BEFORE the fix shipped) WITH stale edges
  const dupId = `dead-dup-${slug}`
  seedDupWithEdges(slug, dupId)
  assert.ok(deadDupForFile(slug), 'F: legacy dup seeded at the source')
  assert.ok(edgeCountForId(dupId) >= 2, 'F: dup carries stale edges')

  // a HEALTHY update of the thread (NOT a strip) must still sweep the dup + edges
  writeGoodThread(slug, id, 'do the important F thing v2')
  await syncMemories(dir)
  assert.equal(getThread(id)?.state.nextStep, 'do the important F thing v2', 'F: healthy update applied')
  assert.equal(deadDupForFile(slug), undefined, 'F: healthy thread re-sync swept the dead dup at its source')
  assert.equal(edgeCountForId(dupId), 0, 'F: swept dup leaves NO dangling edges')
  ok('r5-widening — a healthy thread sync self-cleans dead dups + their edges')
}

console.log(`\nOK thread-strip-resilience.test.ts — ${passed} assertions passed`)
