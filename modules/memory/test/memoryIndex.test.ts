import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { STUB_LINE } from '../server/consume.js'
import { BLOCK, renderMemoryIndex } from '../server/memoryIndex.js'

const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const memDir = () => {
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mi-')), 'memory')
  fs.mkdirSync(d, { recursive: true })
  dirs.push(path.dirname(d))
  return d
}

// Shaped like a real pre-V2 MEMORY.md, plus things that are not memory at all.
const ORIGINAL = `# Memory index

- [Release script](release-script.md) - where the release script lives
- [Deploy rule](deploy-rule.md) - never deploy on Fridays
- [Pending note](pending.md) - still a real memory, not yet in Cortex
- [Lost one](missing.md) - the file is gone

## Standing rules (not memory, keep)
- Never print secrets; secrets come from OpenBao.
- permissions: allow Bash(git status) - someone pasted this here

## Old project
- [Old thing](old-thing.md) - moved to Cortex
`

const rig = () => {
  const d = memDir()
  fs.writeFileSync(path.join(d, 'MEMORY.md'), ORIGINAL)
  for (const f of ['release-script.md', 'deploy-rule.md', 'old-thing.md']) fs.writeFileSync(path.join(d, f), STUB_LINE + '\n')
  fs.writeFileSync(path.join(d, 'pending.md'), '---\nname: pending\n---\n\nreal content\n')
  return d
}

test('only index lines whose memory is now in Cortex are removed; everything else stays', () => {
  const d = rig()
  const r = renderMemoryIndex(d)
  const out = fs.readFileSync(path.join(d, 'MEMORY.md'), 'utf-8')

  assert.equal(r.removed, 3)
  assert.ok(out.startsWith(BLOCK), 'the generic Cortex block leads')
  for (const gone of ['release-script.md', 'deploy-rule.md', 'old-thing.md']) assert.ok(!out.includes(gone), gone)
  assert.ok(out.includes('[Pending note](pending.md)'), 'a file with real content keeps its line')
  assert.ok(out.includes('[Lost one](missing.md)'), 'a dangling pointer is not ours to remove')
  assert.ok(out.includes('Never print secrets; secrets come from OpenBao.'), 'rules stay')
  assert.ok(out.includes('permissions: allow Bash(git status)'), 'settings-like text stays')
  assert.ok(out.includes('## Standing rules (not memory, keep)'))
  assert.ok(!out.includes('## Old project'), 'a heading the render emptied goes')
  assert.ok(out.includes('# Memory index'), 'a heading with content left keeps')
})

test('the original is kept once, and a second render changes nothing', () => {
  const d = rig()
  renderMemoryIndex(d)
  const first = fs.readFileSync(path.join(d, 'MEMORY.md'), 'utf-8')
  assert.equal(fs.readFileSync(path.join(d, 'MEMORY.md.pre-cortex'), 'utf-8'), ORIGINAL)
  assert.equal(renderMemoryIndex(d).changed, false)
  assert.equal(fs.readFileSync(path.join(d, 'MEMORY.md'), 'utf-8'), first)
})

test('a line Claude appends later is removed once its file is swept', () => {
  const d = rig()
  renderMemoryIndex(d)
  fs.appendFileSync(path.join(d, 'MEMORY.md'), '- [New fact](new-fact.md) - written by a session\n')
  fs.writeFileSync(path.join(d, 'new-fact.md'), 'not swept yet\n')
  assert.equal(renderMemoryIndex(d).removed, 0, 'still a real memory: kept')
  fs.writeFileSync(path.join(d, 'new-fact.md'), STUB_LINE + '\n')
  renderMemoryIndex(d)
  assert.ok(!fs.readFileSync(path.join(d, 'MEMORY.md'), 'utf-8').includes('new-fact.md'))
})

test('TAKE IN, THEN REDUCE: prose becomes memory files (rules standing), stale pointers go, unresolved ones stay with a reason', async () => {
  const { planTakeIn, applyTakeIn } = await import('../server/memoryIndex.js')
  const { frontmatterOf } = await import('../server/frontmatter.js')
  const d = memDir()
  fs.writeFileSync(path.join(d, 'no-todo.md'), STUB_LINE + '\n')
  fs.writeFileSync(path.join(d, 'pending.md'), '---\nname: pending\n---\nnot ingested yet\n')
  fs.writeFileSync(
    path.join(d, 'MEMORY.md'),
    [
      BLOCK,
      '# Memory',
      'This file is a slim always-loaded subset: standing rules plus active work. Search with ckn search.',
      '## Standing rules',
      '- Never leave a TODO in shipped text.',
      '- Never state what cannot be cited.',
      '- [No TODO](no-todo.md) - rule',
      '## Active work',
      '- [Pending](pending.md) - still a real file',
      '- [Gone](gone.md) - deleted',
      '',
    ].join('\n'),
  )
  const plan = planTakeIn(d)!
  assert.deepEqual(plan.takeIn.map((t) => [t.heading, t.standing, t.lines]), [['Memory', false, 1], ['Standing rules', true, 2]])
  assert.equal(plan.stale, 1)
  assert.deepEqual(plan.unresolved.map((u) => u.reason.split(':')[0]), ['not in Cortex yet', 'missing'])
  assert.equal(fs.readFileSync(path.join(d, 'MEMORY.md'), 'utf-8').includes('slim always-loaded'), true, 'a plan writes nothing')

  const r = applyTakeIn(d, plan, 'test')
  assert.equal(r.written.length, 2)
  const rules = fs.readFileSync(path.join(d, 'memory-md-standing-rules.md'), 'utf-8')
  assert.equal(frontmatterOf(rules).standing, true)
  assert.match(rules, /- Never leave a TODO in shipped text\.\n- Never state what cannot be cited\./)
  const now = fs.readFileSync(path.join(d, 'MEMORY.md'), 'utf-8')
  assert.ok(now.startsWith(BLOCK))
  assert.ok(!now.includes('slim always-loaded') && !now.includes('no-todo.md'))
  assert.match(now, /\[Gone\]\(gone\.md\).*missing/)
  assert.ok(fs.existsSync(r.backup))
  // Applied once: nothing left to take in, and a rerun would not overwrite the files.
  assert.equal(planTakeIn(d)!.takeIn.length, 0)
})
