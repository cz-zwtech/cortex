#!/usr/bin/env tsx
/**
 * memoryIndexCap — keep MEMORY.md under the harness auto-memory load cap (~200
 * lines / 25KB) so the WHOLE working index loads each session. Pure planner:
 * pin standing-rule/user pointers, archive completed/superseded ones to a sibling
 * MEMORY-archive.md (not auto-loaded), and flag (loud-warn) if the un-archivable
 * remainder still exceeds the cap. Safe v1: only archive by explicit completion
 * markers — never guess "oldest" and risk dropping an active pointer.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { classifyEntry, planIndexPrune, applyIndexPrune } = await import('../server/graph/memoryIndexCap.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// ── classifyEntry: pin (feedback-/user-) + archive markers ──
{
  assert.equal(classifyEntry('- [X](feedback-foo.md) — hook').pinned, true, 'feedback-* pinned')
  assert.equal(classifyEntry('- [X](user-pref.md) — hook').pinned, true, 'user-* pinned')
  assert.equal(classifyEntry('- [X](cortex-thing.md) — SHIPPED bbd4ded').archivable, true, 'SHIPPED archivable')
  assert.equal(classifyEntry('- [X](cortex-thing.md) — superseded by Y').archivable, true, 'superseded archivable')
  assert.equal(classifyEntry('- [X](cortex-thing.md) — active WIP open').archivable, false, 'active not archivable')
  const c = classifyEntry('- [X](feedback-foo.md) — DONE')
  assert.ok(c.pinned && c.archivable, 'a pinned entry can also carry a done marker')
  ok('classifyEntry: pin (feedback-/user-) + completion markers')
}

// ── under cap → no-op (no churn) ──
{
  const small = 'Index header\n- [A](cortex-a.md) — x\n- [B](feedback-b.md) — y\n'
  const p = planIndexPrune(small, { capBytes: 99999, capLines: 9999 })
  assert.equal(p.archived.length, 0, 'under cap → nothing archived')
  assert.equal(p.overCap, false, 'under cap → not flagged')
  ok('planIndexPrune: no-op when already under cap')
}

// ── over cap → archive completed-non-pinned, KEEP pinned + active ──
{
  const entries: string[] = []
  for (let i = 0; i < 50; i++) entries.push(`- [Done${i}](cortex-d${i}.md) — SHIPPED commit${i}`)
  entries.push('- [Pinned](feedback-keep.md) — standing rule')
  entries.push('- [Active](cortex-active.md) — WIP open thread')
  const content = 'Index header\n' + entries.join('\n') + '\n'
  const p = planIndexPrune(content, { capBytes: 500, capLines: 10 })
  assert.ok(p.archived.length >= 50, 'archives the completed pointers')
  assert.ok(p.kept.some((l) => l.includes('feedback-keep')), 'keeps the pinned pointer')
  assert.ok(p.kept.some((l) => l.includes('cortex-active')), 'keeps the active pointer')
  assert.ok(!p.archived.some((l) => l.includes('feedback-keep')), 'never archives a pinned pointer')
  ok('planIndexPrune: archives completed-non-pinned, keeps pinned + active')
}

// ── overCap warn flag when the un-archivable remainder still exceeds the cap ──
{
  const entries: string[] = []
  for (let i = 0; i < 50; i++) {
    entries.push(`- [Pin${i}](feedback-p${i}.md) — standing rule ${i} with a longish hook to add some bytes here`)
  }
  const content = 'H\n' + entries.join('\n') + '\n'
  const p = planIndexPrune(content, { capBytes: 500, capLines: 10 })
  assert.equal(p.archived.length, 0, 'nothing archivable (all pinned)')
  assert.equal(p.overCap, true, 'overCap flag set so the caller warns loudly')
  ok('planIndexPrune: overCap flag when un-archivable content alone exceeds cap')
}

// ── 24KB margin: a HEALTHY all-pinned index (~23KB, between the old 22KB and the
//    new 24KB margin) with nothing archivable must NOT perpetually warn ──
{
  const lines = ['Index header']
  for (let i = 0; i < 160; i++) {
    lines.push(`- [Standing rule ${i}](feedback-rule-${i}.md) — pinned standing rule `.padEnd(145, 'x'))
  }
  const content = lines.join('\n') + '\n'
  const bytes = Buffer.byteLength(content, 'utf-8')
  assert.ok(bytes > 22000 && bytes < 24000, `fixture sits between the old and new byte margin (${bytes}B)`)
  const p = planIndexPrune(content) // default caps: 24KB / 190 lines
  assert.equal(p.archived.length, 0, 'nothing archivable (all pinned)')
  assert.equal(p.overCap, false, 'a healthy ~23KB all-pinned index does NOT warn under the 24KB margin')
  ok('planIndexPrune: 24KB margin — a healthy ~23KB pinned index does not spuriously warn')
}

// ── applyIndexPrune (I/O): over-cap MEMORY.md → archive completed, keep pinned+active, idempotent ──
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'memcap-'))
  const md = path.join(dir, 'MEMORY.md')
  const lines = ['Index header']
  for (let i = 0; i < 40; i++) lines.push(`- [Done${i}](cortex-d${i}.md) — SHIPPED commit${i}`)
  lines.push('- [Pin](feedback-keep.md) — standing rule')
  lines.push('- [Active](cortex-active.md) — WIP open')
  writeFileSync(md, lines.join('\n') + '\n')

  const r = await applyIndexPrune(md, { capBytes: 400, capLines: 8 })
  assert.ok(r && r.archivedCount >= 40, 'archived the completed pointers')
  const keptMd = readFileSync(md, 'utf-8')
  assert.ok(!keptMd.includes('](cortex-d0.md)'), 'a completed pointer is removed from MEMORY.md')
  assert.ok(keptMd.includes('feedback-keep') && keptMd.includes('cortex-active'), 'pinned + active kept')
  assert.ok(keptMd.startsWith('Index header'), 'header preserved')
  const arch = readFileSync(path.join(dir, 'MEMORY-archive.md'), 'utf-8')
  assert.ok(arch.includes('](cortex-d0.md)') && arch.includes('](cortex-d39.md)'), 'completed pointers landed in the archive')

  const r2 = await applyIndexPrune(md, { capBytes: 400, capLines: 8 })
  assert.ok(r2 && r2.archivedCount === 0, 're-run is a no-op (nothing left to archive)')
  rmSync(dir, { recursive: true, force: true })
  ok('applyIndexPrune: archives completed → MEMORY-archive.md, keeps pinned+active, idempotent')
}

// ── absent MEMORY.md → null (skipped, no throw) ──
{
  const r = await applyIndexPrune(path.join(os.tmpdir(), 'no-such-cortex-dir-xyz', 'MEMORY.md'))
  assert.equal(r, null, 'absent MEMORY.md → null')
  ok('applyIndexPrune: absent file → null')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
