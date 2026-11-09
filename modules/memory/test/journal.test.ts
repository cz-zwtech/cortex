import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { hashContent, Journal } from '../server/journal.js'

const dirs: string[] = []
const tmpdir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-journal-'))
  dirs.push(d)
  return d
}
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const mem = (over: Partial<Parameters<Journal['appendMemory']>[0]> = {}) => ({
  source: '/memory/m1.md',
  scope: 'user',
  machine: 'node-a',
  authoredAt: 1000,
  content: 'the fact',
  ...over,
})

test('an appended memory survives a fresh open — the journal is the durable copy', () => {
  const dir = tmpdir()
  new Journal({ dir, machine: 'node-a' }).appendMemory(mem())

  // Reopened, not reused: this asserts DISK state, not in-process state.
  const replayed = new Journal({ dir, machine: 'node-a' }).replay()
  assert.equal(replayed.length, 1)
  assert.equal(replayed[0]!.content, 'the fact')
})

test('seq is recovered from the log, not from a sidecar counter', () => {
  const dir = tmpdir()
  const a = new Journal({ dir, machine: 'node-a' })
  a.appendMemory(mem())
  a.appendMemory(mem({ content: 'second' }))

  const b = new Journal({ dir, machine: 'node-a' })
  const next = b.appendMemory(mem({ content: 'third' }))
  assert.equal(next.seq, 3, 'a reopened journal does not restart numbering')
})

test('segments roll on size so a redaction rewrite stays bounded', () => {
  const dir = tmpdir()
  const j = new Journal({ dir, machine: 'node-a', segmentBytes: 200 })
  for (let i = 0; i < 12; i++) j.appendMemory(mem({ content: `fact ${i} ${'x'.repeat(40)}` }))

  assert.ok(j.segments().length > 1, 'more than one segment exists')
  assert.equal(j.replay().length, 12, 'rolling loses nothing')
})

test('a torn line does not make the journal unreadable', () => {
  // The ordinary outcome of a power loss mid-append. If this threw, the
  // recovery story would fail exactly when it is being relied on.
  const dir = tmpdir()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory(mem({ content: 'before' }))
  fs.appendFileSync(j.segments()[0]!, '{"kind":"memory","seq":99,"conte')

  const replayed = new Journal({ dir, machine: 'node-a' }).replay()
  assert.deepEqual(replayed.map((r) => r.content), ['before'])
})

test('replay applies tombstones and redactions rather than trusting the caller', () => {
  const dir = tmpdir()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory(mem({ content: 'kept' }))
  j.appendMemory(mem({ content: 'secret' }))
  j.appendRedaction({ targetHash: hashContent('secret') })

  assert.deepEqual(
    j.replay().map((r) => r.content),
    ['kept'],
    'a replay that returned redacted content would be one forgetful consumer from a leak',
  )
})

test('redact removes the content from the SEGMENT, not just from replay', () => {
  // Asserting on replay alone is the symptom; the durable state is the bytes on
  // disk. A redaction that only filters would leave the secret sitting in a
  // file that syncs.
  const dir = tmpdir()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory(mem({ content: 'keep me' }))
  j.appendMemory(mem({ content: 'sk-live-DEADBEEF' }))

  const removed = j.redact(hashContent('sk-live-DEADBEEF'))
  assert.equal(removed, 1)

  const onDisk = j.segments().map((s) => fs.readFileSync(s, 'utf-8')).join('')
  assert.ok(!onDisk.includes('sk-live-DEADBEEF'), 'the bytes are gone from disk')
  assert.ok(onDisk.includes('keep me'), 'the rewrite kept everything else')
})

test('the redaction record survives the rewrite it describes', () => {
  // Without this, a peer restored from a pre-redaction backup replays nothing
  // and the content comes back. This is the whole reason the manifest is
  // permanent.
  const dir = tmpdir()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory(mem({ content: 'secret' }))
  j.redact(hashContent('secret'))

  // Read from the MANIFEST, not the segments. The record deliberately does not
  // live in the files a redaction rewrites — that was the earlier shape, and it
  // put a permanent record inside the very thing a restore replaces.
  const redactions = new Journal({ dir, machine: 'node-a' }).redactions()
  assert.equal(redactions.length, 1, 'the record outlives the rewrite')
  assert.equal(new Journal({ dir, machine: 'node-a' }).epoch(), 1, 'and the epoch is recoverable from disk')
})

test('the redaction record carries NO payload', () => {
  // If the tombstone contained the body, the manifest would be the leak it
  // exists to prevent.
  const dir = tmpdir()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory(mem({ content: 'sk-live-DEADBEEF' }))
  j.redact(hashContent('sk-live-DEADBEEF'), { note: 'rotated' })

  const raw = j.segments().map((s) => fs.readFileSync(s, 'utf-8')).join('')
  assert.ok(!raw.includes('sk-live-DEADBEEF'), 'not in the record, not anywhere')
})

test('redaction is safely re-runnable — a half-applied one is the danger', () => {
  const dir = tmpdir()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory(mem({ content: 'secret' }))

  assert.equal(j.redact(hashContent('secret')), 1)
  assert.equal(j.redact(hashContent('secret')), 0, 'zero removed is not an error')
  assert.equal(j.epoch(), 2, 'each attempt is still recorded')
})

test('a redaction for content never held is a no-op, not a failure', () => {
  const dir = tmpdir()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory(mem({ content: 'kept' }))

  assert.equal(j.redact(hashContent('never here')), 0)
  assert.deepEqual(j.replay().map((r) => r.content), ['kept'])
})

test('refuses a journal on a Windows drive mount, and names the fix', () => {
  // The realistic way to land here is deriving the journal path from the
  // INSTALL home (a checkout, which on a WSL machine may be under /mnt/d) rather
  // than from the state dir, which is already on ext4. A refusal that only says
  // "no" sends the reader hunting a filesystem problem instead of a path one.
  assert.throws(
    () => new Journal({ dir: '/mnt/d/projects/dashboard/journal', machine: 'wsl' }),
    (err: Error) => /CKN_STATE_DIR/.test(err.message) && /drvfs/.test(err.message),
  )
})

test('the drvfs refusal is a refusal, not a warning — but is overridable', () => {
  const dir = path.join(tmpdir(), 'sub')
  assert.doesNotThrow(
    () => new Journal({ dir, machine: 'node-a', allowUnsafeFilesystem: true }),
    'an operator who knows better is not blocked',
  )
})

test('mid-segment corruption is REPORTED; a torn tail is not', () => {
  // Same code path, different disposition. The difference is whether a failing
  // disk announces itself or quietly eats memories.
  const dir = tmpdir()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory(mem({ content: 'first' }))
  j.appendMemory(mem({ content: 'second' }))

  const seg = j.segments()[0]!
  const lines = fs.readFileSync(seg, 'utf-8').split('\n').filter((l) => l.trim())
  // Corrupt the FIRST record and leave a valid one after it: that ordering is
  // what makes it corruption rather than a torn append.
  fs.writeFileSync(seg, ['{"kind":"memory","broke', lines[1]].join('\n') + '\n')

  const reopened = new Journal({ dir, machine: 'node-a' })
  const kept = reopened.replay()
  assert.deepEqual(kept.map((r) => r.content), ['second'], 'salvages what it can')
  assert.equal(reopened.integrity().length, 1, 'and does not do it silently')
  assert.match(reopened.integrity()[0]!.reason, /corruption/)
})

test('a record altered on disk is caught by its own hash', () => {
  const dir = tmpdir()
  const j = new Journal({ dir, machine: 'node-a' })
  j.appendMemory(mem({ content: 'original' }))
  j.appendMemory(mem({ content: 'trailing' }))

  const seg = j.segments()[0]!
  const raw = fs.readFileSync(seg, 'utf-8').replace('original', 'tampered')
  fs.writeFileSync(seg, raw)

  const reopened = new Journal({ dir, machine: 'node-a' })
  reopened.replay()
  assert.equal(reopened.integrity().length, 1)
  assert.match(reopened.integrity()[0]!.reason, /hash mismatch/)
})

// ── tombstones: the deletion an append-only log can express ──────────────────

test('REPLAY HONOURS TOMBSTONES — it collected them and never applied them', () => {
  // The set was populated and then absent from the filter, while the method's
  // doc comment claimed "tombstones already applied". Not a forgotten line:
  // MemoryRecord HAS NO GRAPH ID, so a tombstone naming a memoryId could never
  // be joined to anything. The set was unusable, not merely unused.
  const j = new Journal({ dir: tmpdir(), machine: 'node-a' })
  const rec = j.appendMemory(mem({ content: 'a durable fact with several words in it' }))

  assert.equal(j.replay().length, 1)

  j.appendTombstone({ memoryId: 'graph-id-1', targetHash: rec.contentHash, machine: 'node-a' })
  assert.deepEqual(j.replay(), [], 'the record is gone from the rebuild')
})

test('A TOMBSTONE IS BOUNDED BY SEQUENCE — a later re-save survives', () => {
  // This is what separates a deletion from a redaction. A redaction suppresses a
  // hash FOREVER because the secret must never come back; a deletion must not,
  // or writing the same fact again after deleting it would silently never take.
  const j = new Journal({ dir: tmpdir(), machine: 'node-a' })
  const body = 'the same fact written twice at different times'
  const first = j.appendMemory(mem({ content: body }))
  j.appendTombstone({ memoryId: 'g1', targetHash: first.contentHash, machine: 'node-a' })
  assert.deepEqual(j.replay(), [])

  const again = j.appendMemory(mem({ content: body, authoredAt: 2000 }))
  const out = j.replay()
  assert.equal(out.length, 1, 'the re-save lives')
  assert.equal(out[0]!.seq, again.seq)
})

test('a tombstone for an unknown hash changes nothing', () => {
  const j = new Journal({ dir: tmpdir(), machine: 'node-a' })
  j.appendMemory(mem({ content: 'a fact that nobody deleted' }))
  j.appendTombstone({ memoryId: 'g9', targetHash: 'no-such-hash', machine: 'node-a' })
  assert.equal(j.replay().length, 1)
})

test('tombstones survive a reopen — deletion is durable, not in-process', () => {
  const dir = tmpdir()
  const a = new Journal({ dir, machine: 'node-a' })
  const rec = a.appendMemory(mem({ content: 'a fact that will be deleted durably' }))
  a.appendTombstone({ memoryId: 'g1', targetHash: rec.contentHash, machine: 'node-a' })

  assert.deepEqual(new Journal({ dir, machine: 'node-a' }).replay(), [], 'still gone after reopen')
})
