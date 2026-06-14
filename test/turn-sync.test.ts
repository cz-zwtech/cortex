#!/usr/bin/env tsx
/**
 * Silent-layer turn-sync gate. decideTurnSync() is the pure guard that makes a no-change
 * turn free (a coarse in-memory comparison, not a 2700-file read+hash) and enforces
 * single-flight; triggerTurnSync() runs the fold async (never blocking the caller) and
 * advances the watermark to the change-time captured at fold START, so a change arriving
 * mid-fold is re-folded next turn rather than lost.
 */
import assert from 'node:assert/strict'

const { decideTurnSync, triggerTurnSync, turnSyncState, noteMemoryChange, _resetTurnSync, isMemoryMdPath } =
  await import('../server/graph/turnSync.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}
const tick = () => new Promise((r) => setTimeout(r, 10))

// ── isMemoryMdPath: BOTH memory scopes bump the change-guard ──────────────────
// User-scoped (~/.claude/memory/*.md) AND project-scoped (~/.claude/projects/<enc>/memory/*.md).
// Missing the user scope would leave snapshot-written user-wide memories unfolded for a turn.
assert.equal(isMemoryMdPath('/home/u/.claude/memory/foo.md'), true)
ok('user-scoped ~/.claude/memory/*.md → memory md')
assert.equal(isMemoryMdPath('/home/u/.claude/projects/-mnt-e-x/memory/bar.md'), true)
ok('project-scoped ~/.claude/projects/<enc>/memory/*.md → memory md')
assert.equal(isMemoryMdPath('/home/u/.claude/projects/-mnt-e-x/memory/MEMORY.md'), true)
ok('the MEMORY.md index → memory md')
assert.equal(isMemoryMdPath('/home/u/.claude/settings.json'), false)
ok('a non-.md config file → not memory md')
assert.equal(isMemoryMdPath('/home/u/repo/src/memory/x.md'), false)
ok('a non-.claude /memory/ path → not memory md')
assert.equal(isMemoryMdPath('/home/u/.claude/projects/-mnt-e-x/session.jsonl'), false)
ok('a session transcript → not memory md')

// ── decideTurnSync (pure) ────────────────────────────────────────────────────
assert.equal(decideTurnSync({ inFlight: true, lastChangeMs: 5, lastFoldMs: 1 }), 'in-flight')
ok('a fold in flight → in-flight (single-flight, no stacking)')
assert.equal(decideTurnSync({ inFlight: false, lastChangeMs: null, lastFoldMs: null }), 'fold')
ok('never folded this boot → fold once (catches offline edits, warms watermark)')
assert.equal(decideTurnSync({ inFlight: false, lastChangeMs: null, lastFoldMs: 100 }), 'skip')
ok('folded + no md change seen since boot → skip')
assert.equal(decideTurnSync({ inFlight: false, lastChangeMs: 100, lastFoldMs: 100 }), 'skip')
ok('change not newer than watermark → skip')
assert.equal(decideTurnSync({ inFlight: false, lastChangeMs: 200, lastFoldMs: 100 }), 'fold')
ok('change newer than watermark → fold')

// ── triggerTurnSync (async fold, single-flight, watermark) ───────────────────
_resetTurnSync()
{
  let calls = 0
  const d = triggerTurnSync(async () => {
    calls++
  }, 1000)
  assert.equal(d, 'fold', 'first call (never folded) → fold')
  await tick()
  assert.equal(calls, 1, 'fold ran once, async')
  assert.equal(turnSyncState().inFlight, false, 'inFlight cleared after fold')
  assert.equal(turnSyncState().lastFoldMs, 1000, 'watermark = fold-start time when no change recorded')
  ok('triggerTurnSync runs the fold async + advances watermark + clears inFlight')
}

_resetTurnSync()
{
  noteMemoryChange(2000)
  const d = triggerTurnSync(async () => {}, 3000)
  assert.equal(d, 'fold')
  await tick()
  assert.equal(turnSyncState().lastFoldMs, 2000, 'watermark = change time captured at fold start, not now')
  ok('watermark = change time at fold start (a mid-fold change re-folds next turn)')
}

_resetTurnSync()
{
  noteMemoryChange(2000)
  triggerTurnSync(async () => {}, 3000)
  await tick()
  let calls = 0
  const d = triggerTurnSync(async () => {
    calls++
  }, 4000)
  assert.equal(d, 'skip', 'no new change after a fold → skip')
  assert.equal(calls, 0, 'fold not called on skip')
  ok('no new change after a fold → skip, fold not invoked')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
