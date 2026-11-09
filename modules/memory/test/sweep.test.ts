import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

import { hashContent, Journal } from '../server/journal.js'
import { MemoryStore } from '../server/store.js'
import { STUB_LINE } from '../server/consume.js'
import { recall } from '../server/recall.js'
import { reindex } from '../server/reindex.js'
import { lexicalSeed } from '../server/seed.js'
import { sweep } from '../server/sweep.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const rig = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sweep-'))
  dirs.push(root)
  const memoryDir = path.join(root, 'memory')
  fs.mkdirSync(memoryDir)
  const db = new Database(':memory:')
  db.exec(schema)
  const store = new MemoryStore(db)
  const journal = new Journal({ dir: path.join(root, 'journal'), machine: 'node-a' })
  return { memoryDir, store, journal, deps: { store, journal } }
}

const memo = (slug: string, body: string) => `---\nname: ${slug}\n---\n\n${body}\n`

const A = 'The release script lives at bin/release.sh and takes the git tag as its argument.'
const B = 'Staging runs on port 5433 and is reseeded nightly from an anonymised production dump.'
const LEAK = 'The token is ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and it must never be indexed.'

test('a memory dir goes in and a graph comes out', () => {
  // The whole point of this file: everything else was proven in process. This
  // is a directory on one end and a graph on the other.
  const { memoryDir, store, journal, deps } = rig()
  fs.writeFileSync(path.join(memoryDir, 'notes.md'), memo('release-script', A))

  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  assert.equal(r.files, 1)
  assert.equal(r.ingested, 1)
  assert.equal(journal.replay().length, 1, 'durable')
  assert.equal(store.count(), 1, 'and in the graph')
  const left = fs.readFileSync(path.join(memoryDir, 'notes.md'), 'utf-8')
  assert.ok(!left.includes(A), 'the content left the inbox')
  assert.match(left, /cortex:stub/, 'and a pointer took its place')
})

test('MEMORY.md is never treated as an inbox', () => {
  // It is a RENDERED VIEW, not an input surface. Consuming it would empty the
  // fallback digest: the one artifact guaranteed present when Cortex is absent.
  const { memoryDir, store, deps } = rig()
  const index = path.join(memoryDir, 'MEMORY.md')
  fs.writeFileSync(index, memo('index', 'A rendered digest that must survive.'))

  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  assert.equal(r.files, 0)
  assert.equal(store.count(), 0)
  assert.match(fs.readFileSync(index, 'utf-8'), /must survive/)
})

test('a file with many memories consumes only the clean ones', () => {
  // Partial consume, end to end, with the decline receipt landing in the file.
  const { memoryDir, store, journal, deps } = rig()
  const file = path.join(memoryDir, 'inbox.md')
  fs.writeFileSync(file, [memo('a', A), memo('leak', LEAK), memo('b', B)].join('\n'))

  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  assert.equal(r.ingested, 2)
  assert.equal(r.declined, 1)
  assert.equal(r.dropped, 2)

  const left = fs.readFileSync(file, 'utf-8')
  assert.ok(left.includes(LEAK), 'the declined memory is still the only copy')
  assert.ok(!left.includes(A) && !left.includes(B), 'the clean ones went')
  assert.match(left, /cortex:held/, 'and the writer is told why')

  const onDisk = journal.segments().map((s) => fs.readFileSync(s, 'utf-8')).join('')
  assert.ok(!onDisk.includes('ghp_AAAA'), 'the credential never reached the journal')
  assert.equal(store.count(), 2)
})

test('the sweep is idempotent: a second pass over an emptied dir does nothing', () => {
  const { memoryDir, store, deps } = rig()
  fs.writeFileSync(path.join(memoryDir, 'notes.md'), memo('a', A))

  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  const second = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  assert.equal(second.ingested, 0)
  assert.equal(store.count(), 1, 'no duplicate node')
})

test('re-sweeping a still-declined file does not stack notices', () => {
  const { memoryDir, store, deps } = rig()
  const file = path.join(memoryDir, 'inbox.md')
  fs.writeFileSync(file, memo('leak', LEAK))

  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  const once = fs.readFileSync(file, 'utf-8')
  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  assert.equal(fs.readFileSync(file, 'utf-8'), once, 'stable across passes')
  assert.equal(store.quarantined().length, 1)
})

test('a missing memory dir is the normal state of a fresh install', () => {
  const { store, deps } = rig()
  const r = sweep({ memoryDir: '/nonexistent/path/here', scope: 'user', machine: 'node-a' }, deps)
  assert.equal(r.files, 0)
  assert.equal(store.count(), 0)
})

// ── the stub left behind ─────────────────────────────────────────────────────

test('a consumed file holds only the generic stub, nothing about the memory', () => {
  // 2026-10-13: the file must not let a session answer from it.
  const { memoryDir, deps } = rig()
  const file = path.join(memoryDir, 'notes.md')
  fs.writeFileSync(file, `---\nname: release-script\ndescription: where the release script lives\n---\n\n${A}\n`)

  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  assert.equal(fs.readFileSync(file, 'utf-8'), STUB_LINE + '\n')
  assert.ok(!STUB_LINE.includes(r.receipts[0]!.id))
})

test('a stub is never ingested, and a stub-only file is not an inbox', () => {
  const { memoryDir, store, journal, deps } = rig()
  const file = path.join(memoryDir, 'notes.md')
  fs.writeFileSync(file, memo('a', A))

  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  const stubbed = fs.readFileSync(file, 'utf-8')
  const second = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  assert.equal(second.files, 0, 'nothing to ingest')
  assert.equal(store.count(), 1)
  assert.equal(journal.replay().length, 1)
  assert.equal(fs.readFileSync(file, 'utf-8'), stubbed, 'byte-stable across passes')
})

test('a new memory written under a stub is ingested and the file keeps one stub', () => {
  const { memoryDir, store, deps } = rig()
  const file = path.join(memoryDir, 'notes.md')
  fs.writeFileSync(file, memo('a', A))
  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  fs.appendFileSync(file, '\n' + memo('b', B))
  const second = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  assert.equal(second.ingested, 1)
  assert.equal(store.count(), 2)
  assert.equal(fs.readFileSync(file, 'utf-8'), STUB_LINE + '\n')
})

test('a decline notice does not erase the stubs beside it', () => {
  // annotateDeclines rebuilds the file from stripped blocks; without carrying
  // stubs forward it would delete the pointer consume had just written.
  const { memoryDir, deps } = rig()
  const file = path.join(memoryDir, 'inbox.md')
  fs.writeFileSync(file, [memo('a', A), memo('leak', LEAK)].join('\n'))

  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  const left = fs.readFileSync(file, 'utf-8')

  assert.ok(left.includes(STUB_LINE))
  assert.match(left, /cortex:held/)
  assert.ok(left.includes(LEAK) && !left.includes(A))
})

test('content held on an earlier pass leaves the queue once it is ingested', () => {
  // A tuned gate re-sweeps the same text; status must stop counting it held.
  const { memoryDir, store, deps } = rig()
  const file = path.join(memoryDir, 'inbox.md')
  fs.writeFileSync(file, memo('a', A))
  store.quarantine(hashContent(A), file, [{ kind: 'high-entropy', line: 1, hint: 'x' }])
  assert.equal(store.quarantined().length, 1)

  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  assert.equal(store.quarantined().length, 0)
  assert.equal(store.count(), 1)
})

test('ingest keeps the description and kind the writer declared', () => {
  const { memoryDir, store, deps } = rig()
  fs.writeFileSync(
    path.join(memoryDir, 'rule.md'),
    `---\nname: no-filler-words\ndescription: no filler words in replies\nmetadata:\n  type: feedback\n---\n\n${A}\n`,
  )
  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  const m = store.get(r.receipts[0]!.id)!
  assert.equal(m.description, 'no filler words in replies')
  assert.equal(m.shape, 'feedback')
})

test('reindex restores description and kind from the journal when the files are stubs', () => {
  // Memories ingested before ingest read frontmatter: the row says observation
  // with no description, and the file is a stub, so only the journal remembers.
  const { memoryDir, store, journal, deps } = rig()
  fs.writeFileSync(
    path.join(memoryDir, 'rule.md'),
    `---\nname: rule\ndescription: the rule\ntype: feedback\n---\n\n${A}\n`,
  )
  const id = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps).receipts[0]!.id
  store.setDerived(id, '', 'observation', 'authored')

  const dry = reindex(store, journal, false)
  assert.equal(dry.changed, 1)
  assert.equal(store.get(id)!.shape, 'observation', 'a dry run writes nothing')

  reindex(store, journal, true)
  assert.equal(store.get(id)!.shape, 'feedback')
  assert.equal(store.get(id)!.description, 'the rule')
  assert.equal(reindex(store, journal, true).changed, 0, 'and a second run finds nothing to do')
})

// ── laptop Stage A regression: the exact queries that missed ──────────────

test('"globex admins role" and "who are Globex engineers" find the memory that answers them', () => {
  const { memoryDir, store, deps } = rig()
  const write = (name: string, text: string, at: number) => {
    const f = path.join(memoryDir, `${name.replace(/\W+/g, '-')}.md`)
    fs.writeFileSync(f, text)
    fs.utimesSync(f, at / 1000, at / 1000)
  }
  const now = Date.now()
  write(
    'globex-admins',
    `---\nname: globex_admins group-role pattern\ndescription: how Globex DB access is granted\ntype: reference\n---\n\n` +
      'On 2026-05-09 the Globex DB was reorganized so all four engineers (alex, bob, carol, dave) share the globex_admins group role.\n',
    now - 160 * 86_400_000,
  )
  for (let i = 0; i < 30; i++) {
    write(`globex-note-${i}`, `---\nname: globex-note-${i}\n---\n\nGlobex deploy note ${i}: the nightly job ran and the dashboard refreshed.\n`, now - i * 60_000)
  }
  // The laptop's actual runners-up for "who are Globex engineers".
  write(
    'principle-code-style-by-context',
    `---\nname: principle-code-style-by-context\ndescription: code style depends on the reader\ntype: feedback\n---\n\n` +
      'Who reads the code decides its style: engineers are judged on the globex of clarity, and comments are for people who are new to it.\n',
    now - 86_400_000,
  )
  write(
    'globex-timescaledb-access',
    `---\nname: Globex timescaledb access\ndescription: connecting to the Globex timescale database\ntype: reference\n---\n\n` +
      'Connect through the bastion; access is granted by the globex_admins role.\n',
    now - 2 * 86_400_000,
  )
  write(
    'globex-herald-refactor-state',
    `---\nname: globex-herald-refactor-state\ndescription: where the Globex Herald refactor stands\ntype: project\n---\n\n` +
      'Herald delivery moved to components; the digest job still needs its retry policy.\n',
    now - 3 * 86_400_000,
  )
  write(
    'precompact-411f5f18',
    `---\nname: precompact-411f5f18-2026-06-05T20-35-31-209Z\ntype: memory\nkind: precompact-checkpoint\n---\n\n` +
      'globex admins role engineers globex admins role engineers who are the globex engineers\n',
    now,
  )
  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  for (const q of ['globex admins role', 'who are Globex engineers']) {
    const top = recall(q, { store, seeds: [lexicalSeed(store)], asOf: now }).hits[0]?.memory.name
    assert.equal(top, 'globex_admins group-role pattern', q)
  }
})

test('a V1 pattern with --- inside a code fence stays one memory, and is extracted', () => {
  const { memoryDir, store, deps } = rig()
  fs.writeFileSync(
    path.join(memoryDir, 'pattern-cf5005be98e0.md'),
    `---\nname: "Bash: diff failed"\ndescription: "[fp:cf5005be98e0] Bash(diff a b) fails"\ntype: pattern\nauthorship: auto-extracted\n---\n\n` +
      '# Pattern · Bash\n\nfails with:\n\n```\n--- a/file\n\n---\n+++ b/file\n```\n\nfixed by quoting.\n',
  )
  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  assert.equal(r.ingested, 1, 'one memory, not fragments')
  const m = store.get(r.receipts[0]!.id)!
  assert.equal(m.name, 'Bash: diff failed', 'the frontmatter name, unquoted')
  assert.equal(m.authorship, 'extracted')
})

test('a sweep renders MEMORY.md after consuming, and never where files may not be rewritten', () => {
  const { memoryDir, deps } = rig()
  fs.writeFileSync(path.join(memoryDir, 'fact.md'), memo('fact', A))
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n\n- [Fact](fact.md) - the release script\n- keep this rule\n')
  sweep({ memoryDir, scope: 'user', machine: 'node-a', consume: false }, deps)
  assert.ok(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf-8').includes('fact.md'), 'consume off: untouched')

  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  const out = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf-8')
  assert.ok(!out.includes('fact.md') && out.includes('keep this rule') && out.includes('cortex:memory'))
})

test('a held memory whose file was deleted leaves the quarantine at the next sweep, and is said once', () => {
  // PM, 20 Oct: a quarantined transcript dump was backed up and deleted, and status kept reporting it held.
  const { memoryDir, store, deps } = rig()
  const gone = path.join(memoryDir, 'dump.md')
  const kept = path.join(memoryDir, 'inbox.md')
  fs.writeFileSync(gone, memo('leak', LEAK))
  fs.writeFileSync(kept, memo('leak-two', LEAK.replace('indexed', 'logged')))
  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  assert.equal(store.quarantined().length, 2)

  fs.rmSync(gone)
  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  assert.deepEqual(r.cleared, [gone])
  assert.deepEqual(store.quarantined().map((q) => q.source), [kept], 'a held file that still exists stays held')
  assert.deepEqual(sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps).cleared, [], 'once')
})

test('a file whose text is already a memory is reported as folded into it, never counted as ingested', () => {
  const { memoryDir, deps } = rig()
  fs.writeFileSync(path.join(memoryDir, 'a.md'), memo('first', A))
  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  fs.writeFileSync(path.join(memoryDir, 'b.md'), memo('second', A))
  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  assert.equal(r.ingested, 0)
  assert.equal(r.folded.length, 1)
  assert.equal(r.folded[0]!.source, path.join(memoryDir, 'b.md'))
})

// ── text appended below a stub ─────────────────────────────────────────────────

test('text appended below a stub updates the memory the stub stands for: same id, frontmatter kept, no stray', () => {
  const { memoryDir, store, journal, deps } = rig()
  const file = path.join(memoryDir, 'resume-state.md')
  fs.writeFileSync(file, `---\nname: resume-state\ndescription: Resume point for the deck\ntype: thread\nnext_step: send the deck\n---\n\n${A}\n`)
  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  const [first] = store.byName('resume-state')
  assert.ok(first && fs.readFileSync(file, 'utf-8').includes('cortex:stub'))

  fs.appendFileSync(file, `\nLater, on Friday: ${B}\n`)
  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  assert.deepEqual(r.appendedTo, [{ source: file, into: first!.id }])
  const all = store.byName('resume-state')
  assert.equal(all.length, 1, 'no stray beside it')
  assert.equal(all[0]!.id, first!.id, 'the same memory')
  assert.ok(all[0]!.content.includes(A) && all[0]!.content.includes(B), 'old text and the update')
  assert.equal(all[0]!.description, 'Resume point for the deck', 'its head kept')
  assert.equal(store.count(), 1)
  const last = journal.replay().at(-1)!
  assert.match(last.content, /next_step: send the deck/, 'the journal copy keeps the whole frontmatter')
  assert.match(fs.readFileSync(file, 'utf-8'), /cortex:stub/)
  assert.ok(!fs.readFileSync(file, 'utf-8').includes(B), 'consumed again')
})

test('text below a stub that no single memory owns is held in the file with a note, never ingested', () => {
  const { memoryDir, store, deps } = rig()
  const file = path.join(memoryDir, 'orphan.md')
  fs.writeFileSync(file, `${STUB_LINE}\n\nLater: ${B}\n`)
  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  assert.deepEqual(r.heldAppends, [file])
  assert.equal(store.count(), 0)
  const left = fs.readFileSync(file, 'utf-8')
  assert.ok(left.includes(B), 'kept')
  assert.match(left, /cortex:held[\s\S]*added below a stub/)
  const again = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  assert.equal(again.heldAppends.length, 1, 'still held, note not stacked')
  assert.equal((fs.readFileSync(file, 'utf-8').match(/cortex:held/g) ?? []).length, 1)
})

test('a whole memory with frontmatter below a stub is a memory in its own right', () => {
  const { memoryDir, store, deps } = rig()
  const file = path.join(memoryDir, 'resume-state.md')
  fs.writeFileSync(file, memo('resume-state', A))
  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  fs.appendFileSync(file, `\n${memo('staging-db', B)}`)
  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  assert.deepEqual(r.appendedTo, [])
  assert.equal(store.byName('staging-db').length, 1)
  assert.equal(store.byName('resume-state')[0]!.content.includes(B), false)
})

test('a rule rewritten under the same name is the same rule, whatever its when, do or why became', () => {
  const { memoryDir, store, deps } = rig()
  const file = path.join(memoryDir, 'no-binary-commits.md')
  fs.writeFileSync(file, '---\nname: no-binary-commits\nkind: rule\nwhy: binaries bloat the repo history\nwhen: tool:Bash\ndo: no binary commits\nenforce: remind\n---\n\nNo binary commits.\n')
  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  const [first] = store.rules()
  assert.equal(first!.when, 'tool:Bash')
  fs.writeFileSync(
    file,
    '---\nname: no-binary-commits\nkind: rule\nwhy: a tool-scoped reminder missed binaries added by an editor\nwhen: always\ndo: never commit a binary or a build output; large files go to the asset store under assets/\nenforce: remind\n---\n\nBinaries live in the asset store, never in the repo.\n',
  )
  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  const rules = store.rules()
  assert.equal(rules.length, 1, 'one rule, not two')
  assert.equal(rules[0]!.id, first!.id)
  assert.equal(rules[0]!.when, 'always')
  assert.match(rules[0]!.do, /store under assets/)
})
