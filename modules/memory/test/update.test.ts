/**
 * Update (memory update-retire design, section 1): one name in one scope from one
 * file is one memory, whatever the text. Every version stays in the journal and
 * `history` lists them; an update whose text is unrelated to the version it
 * replaced is said in the sweep result and in the next session's context.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

import { ingest, type IngestInput } from '../server/ingest.js'
import { Journal } from '../server/journal.js'
import { history } from '../server/retire.js'
import { buildSessionContext } from '../server/sessionContext.js'
import { MemoryStore } from '../server/store.js'
import { sweep } from '../server/sweep.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const rig = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-update-'))
  dirs.push(root)
  const memoryDir = path.join(root, 'memory')
  fs.mkdirSync(memoryDir)
  const db = new Database(':memory:')
  db.exec(schema)
  const store = new MemoryStore(db)
  const journal = new Journal({ dir: path.join(root, 'journal'), machine: 'node-a' })
  return { memoryDir, store, journal, deps: { store, journal } }
}

const memo = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\ntype: thread\n---\n\n${body}\n`

const BEFORE = 'The release train leaves on Tuesdays. Tag the build, run the smoke suite, and post the changelog in the release channel before noon.'
const SECTION =
  '\n\n## Afternoon\n\nThe migration of the billing tables finished at three. Two indexes were rebuilt by hand ' +
  'because the planner chose a sequential scan on the invoices table; the fix is in the runbook under ' +
  'billing, with the exact statements, the lock timeouts we used, and the rollback that was not needed.'

const input = (over: Partial<IngestInput> = {}): IngestInput => ({
  content: memo('release-notes', 'the release routine', BEFORE),
  body: BEFORE,
  slug: 'release-notes',
  scope: 'user',
  source: '/memory/release-notes.md',
  machine: 'node-a',
  authoredAt: 1000,
  ...over,
})
const ingested = (r: ReturnType<typeof ingest>) => {
  assert.equal(r.status, 'ingested')
  return r.status === 'ingested' ? r.receipt : assert.fail()
}

test('a stub rewritten in place with a long new section updates the same memory, and history shows both versions', () => {
  const { memoryDir, store, deps } = rig()
  const file = path.join(memoryDir, 'release-notes.md')
  fs.writeFileSync(file, memo('release-notes', 'morning', BEFORE))
  sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)
  const [first] = store.byName('release-notes')
  assert.match(fs.readFileSync(file, 'utf-8'), /cortex:stub/, 'consumed to a stub')

  fs.writeFileSync(file, memo('release-notes', 'afternoon', BEFORE + SECTION))
  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a' }, deps)

  assert.deepEqual(store.byName('release-notes').map((m) => m.id), [first!.id], 'one memory, the same id')
  assert.match(store.get(first!.id)!.content, /billing tables/, 'holding the new text')
  assert.equal(r.receipts[0]!.action, 'update')
  const versions = history(deps, first!.id)
  assert.deepEqual(versions.map((v) => [v.version, v.description, v.current]), [
    [1, 'morning', false],
    [2, 'afternoon', true],
  ])
})

test('a short text under the same name from the same file updates rather than links', () => {
  const { store, deps } = rig()
  const a = ingested(ingest(input({ content: memo('port', 'port', 'Port is 8080.'), body: 'Port is 8080.', slug: 'port' }), deps))
  const b = ingested(ingest(input({ content: memo('port', 'port', 'Port is 8081.'), body: 'Port is 8081.', slug: 'port' }), deps))
  assert.equal(b.id, a.id)
  assert.equal(b.action, 'update')
  assert.equal(store.byName('port').length, 1)
})

test('the same name from another file still links', () => {
  const { store, deps } = rig()
  ingested(ingest(input(), deps))
  const other = 'Staging is reseeded nightly from an anonymised dump and listens on port 5433, never the production port.'
  const r = ingested(ingest(input({ content: memo('release-notes', 'staging', other), body: other, source: '/memory/staging.md' }), deps))
  assert.equal(r.action, 'link')
  assert.equal(store.byName('release-notes').length, 2)
})

test('an earlier version written again with a newer time stays history: the row keeps the latest', () => {
  const { store, deps } = rig()
  const v1 = 'Port is 8080.'
  const v2 = 'Port is 8081.'
  const a = ingested(ingest(input({ content: memo('port', 'port', v1), body: v1, slug: 'port', authoredAt: 1000 }), deps))
  ingested(ingest(input({ content: memo('port', 'port', v2), body: v2, slug: 'port', authoredAt: 2000 }), deps))
  // A copy or a save of the old text: fresh mtime, old content.
  const r = ingested(ingest(input({ content: memo('port', 'port', v1), body: v1, slug: 'port', authoredAt: 3000 }), deps))
  assert.equal(r.id, a.id)
  assert.equal(store.byName('port').length, 1)
  assert.match(store.get(a.id)!.content, /8081/, 'still the latest version')
})

test('unchanged text hits the identical check', () => {
  const { deps } = rig()
  const a = ingested(ingest(input(), deps))
  const b = ingested(ingest(input({ source: '/memory/elsewhere.md' }), deps))
  assert.equal(b.id, a.id)
  assert.equal(b.note, 'slug, unchanged')
})

test('a row with no recorded source, from this machine, is updated by a rewrite and gets the source', () => {
  const { store, deps } = rig()
  const legacy = (id: string, name: string, machine: string) =>
    store.upsert({ id, source: '', name, description: '', content: BEFORE, shape: 'thread', authorship: 'authored', scope: 'user', pinned: false, protected: false, machine, authoredAt: 500, outcome: '', outcomeText: '' })
  legacy('legacy-here', 'release-notes', 'node-a')
  legacy('legacy-there', 'deploy-notes', 'node-b')

  const other = 'Releases now go out every day from the main branch, with the smoke suite as the only gate before the deploy job.'
  const here = ingested(ingest(input({ content: memo('release-notes', 'daily', other), body: other }), deps))
  assert.equal(here.id, 'legacy-here')
  assert.equal(store.get('legacy-here')!.source, '/memory/release-notes.md', 'the source is recorded')

  const there = ingested(ingest(input({ content: memo('deploy-notes', 'daily', other), body: other, slug: 'deploy-notes', source: '/memory/deploy-notes.md' }), deps))
  assert.equal(there.action, 'link', 'a row with no source from another machine is not taken as this file')
})

test('two sessions writing one file with unrelated text: an update, said in the sweep and in the next session', () => {
  const { memoryDir, store, deps } = rig()
  const file = path.join(memoryDir, 'notes.md')
  fs.writeFileSync(file, memo('notes', 'first session', BEFORE))
  sweep({ memoryDir, scope: 'user', machine: 'node-a', consume: false }, deps)
  const unrelated = 'The office printer on the third floor needs the blue driver; the grey one prints every page twice and jams the tray.'
  fs.writeFileSync(file, memo('notes', 'second session', unrelated))
  const r = sweep({ memoryDir, scope: 'user', machine: 'node-a', consume: false }, deps)

  assert.equal(store.byName('notes').length, 1, 'the second replaced the first')
  assert.deepEqual(r.unrelated.map((u) => u.name), ['notes'])
  const ctx = buildSessionContext({ store, asOf: Date.now() })
  assert.match(ctx.text, /updated `notes`; the new text is unrelated to the previous version, which is in `cortex-memory show notes --history`/)
  store.markUpdateNotesShown(ctx.updateNotes)
  assert.doesNotMatch(buildSessionContext({ store, asOf: Date.now() }).text, /updated `notes`/, 'said once')
  assert.equal(history(deps, store.byName('notes')[0]!.id).length, 2, 'the first is in the history')
})
