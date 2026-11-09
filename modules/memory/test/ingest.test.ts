import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

import { Journal } from '../server/journal.js'
import { adoptRecords, ingest, type IngestDeps, type IngestInput } from '../server/ingest.js'
import { hashContent } from '../server/journal.js'
import { MemoryStore } from '../server/store.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const rig = (over: Partial<IngestDeps> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ingest-'))
  dirs.push(dir)
  const db = new Database(':memory:')
  db.exec(schema)
  const store = new MemoryStore(db)
  const journal = new Journal({ dir, machine: 'node-a' })
  return { store, journal, deps: { store, journal, ...over } as IngestDeps }
}

const BODY =
  'Deploy by running the release script on the build host, then wait for the health ' +
  'check to report green before switching traffic over to the new pods.'

const input = (over: Partial<IngestInput> = {}): IngestInput => ({
  content: `---\nname: deploy-process\n---\n\n${BODY}`,
  body: BODY,
  slug: 'deploy-process',
  scope: 'user',
  source: '/memory/deploy.md',
  machine: 'node-a',
  authoredAt: 1000,
  ...over,
})

// ── the ordering constraint ──────────────────────────────────────────────────

test('a credential NEVER reaches the journal', () => {
  // The whole reason the gate sits before the append: the journal is the thing
  // you cannot take content back out of, and it replicates.
  const { journal, deps } = rig()
  const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const r = ingest(input({ content: `key: ${secret}`, body: `key: ${secret}` }), deps)

  assert.equal(r.status, 'quarantined')
  assert.equal(journal.replay().length, 0, 'nothing appended at all')

  const onDisk = journal.segments().map((s) => fs.readFileSync(s, 'utf-8')).join('')
  assert.ok(!onDisk.includes(secret), 'not a redacted record — NO record')
})

test('quarantine records that we declined, and copies nothing', () => {
  const { store, deps } = rig()
  const secret = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  ingest(input({ content: `token ${secret}`, body: `token ${secret}` }), deps)

  const held = store.quarantined()
  assert.equal(held.length, 1)
  assert.equal(held[0]!.source, '/memory/deploy.md')
  assert.ok(!JSON.stringify(held[0]).includes(secret), 'findings never carry the value')
})

test('a declined memory gets NO TICKET — nothing can authorise dropping it', () => {
  // This is what makes copy-nothing safe. Consume drops only what a ticket
  // names, and a decline mints none, so no consume call — however wrongly
  // placed — can remove the only copy.
  const { deps } = rig()
  const r = ingest(input({ content: 'k=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', body: 'x' }), deps)
  assert.equal(r.ticket, null)
})

test('the storage layer REFUSES a consumption for declined content', () => {
  // Belt and braces beneath the type system: a bug that reached this point
  // would remove the only copy, so it fails loudly rather than logging.
  const { store, deps } = rig()
  ingest(input({ content: 'k=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', body: 'declined body' }), deps)

  assert.throws(
    () => store.recordConsume(hashContent('declined body'), 'some-id'),
    /only copy|declined/i,
  )
})

test('re-scanning unchanged declined content is idempotent', () => {
  // A scratchpad is re-scanned every sync cycle; unchanged content must not
  // grow the table on every pass.
  const { store, deps } = rig()
  const bad = input({ content: 'k=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', body: 'same body' })
  ingest(bad, deps)
  ingest(bad, deps)
  ingest(bad, deps)
  assert.equal(store.quarantined().length, 1)
})

test('release is per-hash and pushes through the NORMAL path', () => {
  // A release that wrote straight to the graph would make released memories the
  // one class that never got reconciled.
  const { store, deps } = rig()
  const body = 'Token format is ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA for the docs example.'
  const item = input({ content: body, body })

  assert.equal(ingest(item, deps).status, 'quarantined')

  store.release(hashContent(body), 'documentation example, not a live token')
  const r = ingest(item, deps)
  assert.equal(r.status, 'ingested', 'released content ingests')
  if (r.status !== 'ingested') return
  assert.ok(r.receipt.rung, 'and it went through the ladder, not around it')
})

test('EDIT-TO-FIX just works — the main remediation path, asserted', () => {
  // The writer removes the value and re-saves. This is what actually happens
  // most of the time, and it should be proven rather than assumed.
  const { store, deps } = rig()
  const bad = 'The key is ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and it lives in OpenBao.'
  assert.equal(ingest(input({ content: bad, body: bad }), deps).status, 'quarantined')

  const fixed = 'The GitHub token lives in OpenBao under kv/cortex/secrets, never inline.'
  const r = ingest(input({ content: fixed, body: fixed }), deps)

  assert.equal(r.status, 'ingested')
  assert.notEqual(r.ticket, null, 'and now there is a ticket')
  assert.equal(store.clearDecline(hashContent(bad)), true, 'the decline row can close')
})

// ── the happy path ───────────────────────────────────────────────────────────

test('clean text appends, reconciles, writes, and mints a ticket', () => {
  const { store, journal, deps } = rig()

  const r = ingest(input(), deps)
  assert.equal(r.status, 'ingested')
  if (r.status !== 'ingested') return

  assert.equal(journal.replay().length, 1, 'appended')
  assert.equal(store.get(r.receipt.id)?.content, BODY, 'written to the graph')
  assert.deepEqual(r.ticket.hashes, [hashContent(BODY)], 'the ticket names what landed')
})

test('the receipt carries id AND slug — never id alone', () => {
  // A contract rule, not a convention: rung 0's cheapest corroboration is slug
  // agreement, and it is unavailable if half the pair is missing.
  const { deps } = rig()
  const r = ingest(input(), deps)
  if (r.status !== 'ingested') return assert.fail('expected ingest')

  assert.ok(r.receipt.id)
  assert.equal(r.receipt.slug, 'deploy-process')
})

test('a retry of identical text produces no second node', () => {
  const { store, deps } = rig()
  const a = ingest(input(), deps)
  const b = ingest(input(), deps)
  if (a.status !== 'ingested' || b.status !== 'ingested') return assert.fail()

  assert.equal(a.receipt.id, b.receipt.id)
  assert.equal(store.count(), 1)
})

test('an unrelated fact under the same slug keeps BOTH', () => {
  const { store, deps } = rig()
  ingest(input(), deps)

  const other =
    'The staging database lives on port 5433 and is seeded nightly from an anonymised ' +
    'dump, so never point an integration test at the production port.'
  const r = ingest(input({ content: other, body: other }), deps)
  if (r.status !== 'ingested') return assert.fail()

  assert.equal(store.count(), 2, 'the first was not destroyed')
  assert.equal(r.receipt.settleable, true, 'and the pair is settleable')
})

test('the ticket is only minted after the content is durable in BOTH places', () => {
  // The scratchpad is the only remaining copy of anything the earlier steps
  // failed to land, so authority to drop must not exist until they succeeded.
  const { store, journal, deps } = rig()
  const r = ingest(input(), deps)
  if (r.status !== 'ingested') return assert.fail()

  assert.equal(journal.replay().length, 1, 'in the journal')
  assert.ok(store.get(r.receipt.id), 'and in the graph')
  assert.ok(r.ticket.hashes.length, 'only then is there a ticket')
})

// ── adoption: the second entry point ─────────────────────────────────────────

const peerRecord = (seq: number, content: string) => ({
  kind: 'memory' as const,
  seq,
  slug: 'from-peer',
  source: '/peer/mem.md',
  scope: 'user',
  machine: 'wsl-box',
  authoredAt: 900,
  appendedAt: 900,
  contentHash: hashContent(content),
  content,
})

test('adoption ALWAYS keeps the record, even when it finds a credential', () => {
  // Blocking here would break replication convergence while protecting nothing:
  // the content is already durable at the origin. Prevention is per-origin;
  // cross-machine the remedy is redaction.
  const { journal, deps } = rig()
  const secret = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
  const r = adoptRecords([peerRecord(1, `key: ${secret}`)], deps)
  assert.equal(r.added, 1)
  assert.ok(r.suggestions.length > 0, 'flagged for redaction')
  assert.equal(journal.replay().length, 1, 'convergence preserved')
})

test('adoption preserves foreign machine lineage verbatim', () => {
  const { journal, deps } = rig()
  adoptRecords([peerRecord(7, 'A perfectly ordinary memory from the other machine.')], deps)
  const [r] = journal.replay()
  assert.equal(r!.machine, 'wsl-box')
  assert.equal(r!.seq, 7, 'the origin seq, not a local one')
})

test('FORGET THEN WRITE THE SAME TEXT BACK: it is a memory again, not a silent fold into the deleted one', () => {
  // PM, 20 Oct: the sweep said "ingested", the file was stubbed, and show and recall found nothing,
  // because rung 2 folded the text into the forgotten id through the consume ledger.
  const { store, journal, deps } = rig()
  const first = ingest(input(), deps)
  assert.equal(first.status, 'ingested')
  const id = (first as { receipt: { id: string } }).receipt.id
  journal.appendTombstone({ memoryId: id, targetHash: store.journalHashOf(id)!, machine: 'node-a' })
  store.delete(id)
  assert.ok(!store.get(id))

  const again = ingest(input(), deps)
  assert.equal(again.status, 'ingested')
  const back = (again as { receipt: { id: string; action: string } }).receipt
  assert.notEqual(back.action, 'fold', 'nothing to fold into: the old record is gone')
  assert.ok(store.get(back.id), 'the re-written memory is in the store')
  assert.ok(journal.replay().some((r) => r.kind === 'memory' && store.journalHashOf(back.id) === r.contentHash), 'and alive in the journal after the tombstone')
})
