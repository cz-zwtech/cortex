import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

import { reconcileRedactions } from '../server/epoch.js'
import { hashContent, Journal } from '../server/journal.js'
import { MemoryStore } from '../server/store.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-epoch-'))
  dirs.push(d)
  return d
}

const SECRET = 'The key is sk-ant-api03-PLANTEDsyntheticVALUE0123 and it was rotated.'

const store = () => {
  const db = new Database(':memory:')
  db.exec(schema)
  return new MemoryStore(db)
}

const seed = (s: MemoryStore, content: string) =>
  s.upsert({
    id: 'leaky',
    source: '/memory/x.md',
    name: 'leaky',
    description: '',
    content,
    shape: 'observation',
    authorship: 'authored',
    scope: 'user',
    pinned: false,
    protected: false,
    machine: 'node-a',
    authoredAt: 1,
    ingestedAt: 1,
    outcome: '',
    outcomeText: '',
  } as never)

test('RESTORE, BOOT, ASSERT — no procedural step, and it does not un-redact', () => {
  // Written this way deliberately. A test that replayed the manifest by hand
  // would prove the wrong thing: the whole point is that restore is a human
  // copying files and cannot be trusted to follow a documented procedure.
  const dir = tmp()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory({
    slug: 'leaky',
    source: '/memory/x.md',
    scope: 'user',
    machine: 'node-a',
    authoredAt: 1,
    content: SECRET,
  })

  // BACK UP the segments (the graph backup is modelled by re-seeding below).
  const backup = j.segments().map((s) => ({ file: s, data: fs.readFileSync(s, 'utf-8') }))

  j.redact(hashContent(SECRET), { memoryId: 'leaky', note: 'rotated' })
  assert.equal(j.replay().length, 0, 'redacted')

  // RESTORE the pre-redaction backup. The content is back in the journal, and
  // the graph is back too. Nobody runs any procedure.
  for (const b of backup) fs.writeFileSync(b.file, b.data)
  const s = store()
  seed(s, SECRET)

  // BOOT.
  const rebooted = new Journal({ dir, machine: 'node-a' })
  const report = reconcileRedactions(rebooted, s)

  assert.ok(report.journalRemoved >= 1, 'the journal was repaired')
  assert.equal(report.graphRemoved, 1, 'and so was the graph')
  assert.equal(rebooted.replay().length, 0, 'content is not resolvable')
  assert.equal(s.get('leaky'), null, 'and not recallable')

  const onDisk = rebooted.segments().map((f) => fs.readFileSync(f, 'utf-8')).join('')
  assert.ok(!onDisk.includes('PLANTEDsynthetic'), 'the bytes are gone again')
})

test('the manifest survives a segment restore, because it is a separate file', () => {
  // An earlier revision appended redaction records INTO the segments — which put
  // a permanent record inside the very files a restore replaces. Restoring then
  // erased the evidence and nothing was left to replay.
  const dir = tmp()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory({
    slug: 'leaky', source: '/m.md', scope: 'user', machine: 'node-a', authoredAt: 1, content: SECRET,
  })
  const backup = j.segments().map((s) => ({ file: s, data: fs.readFileSync(s, 'utf-8') }))
  j.redact(hashContent(SECRET))

  for (const b of backup) fs.writeFileSync(b.file, b.data)

  const rebooted = new Journal({ dir, machine: 'node-a' })
  assert.equal(rebooted.redactions().length, 1, 'the record outlived the restore')
  assert.equal(rebooted.epoch(), 1, 'and so did the epoch')
})

test('reconciliation is safe to run on every boot', () => {
  const dir = tmp()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory({
    slug: 'keep', source: '/m.md', scope: 'user', machine: 'node-a', authoredAt: 1,
    content: 'An ordinary memory that nobody redacted.',
  })
  const s = store()
  seed(s, 'An ordinary memory that nobody redacted.')

  const a = reconcileRedactions(j, s)
  const b = reconcileRedactions(j, s)

  assert.equal(a.graphRemoved, 0)
  assert.equal(b.graphRemoved, 0)
  assert.equal(j.replay().length, 1, 'nothing was harmed by running it twice')
  assert.ok(s.get('leaky'), 'and the un-redacted memory is still there')
})

test('an EQUAL epoch still repairs — the counter says nothing about the contents', () => {
  // Deliberately not `if (to <= from) return`. A rolled-back segment set leaves
  // the graph's counter looking current while the journal holds content the
  // manifest says is gone. Trusting the counter would be trusting the restore.
  const dir = tmp()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory({
    slug: 'leaky', source: '/m.md', scope: 'user', machine: 'node-a', authoredAt: 1, content: SECRET,
  })
  const backup = j.segments().map((f) => ({ file: f, data: fs.readFileSync(f, 'utf-8') }))
  j.redact(hashContent(SECRET))

  const s = store()
  reconcileRedactions(j, s)
  assert.equal(s.appliedRedactionEpoch(), 1, 'graph is at the manifest epoch')

  for (const b of backup) fs.writeFileSync(b.file, b.data) // roll the segments back

  const rebooted = new Journal({ dir, machine: 'node-a' })
  const report = reconcileRedactions(rebooted, s)
  assert.equal(report.from, report.to, 'epochs match, so a counter check would skip')
  assert.ok(report.journalRemoved >= 1, 'and it repaired anyway')
})
