/**
 * Unit test for the canonical row mappers (server/graph/_rows.ts).
 *
 * Opens a temp SQLite DB via openDb(), inserts a representative row per table,
 * reads it back (so the 0/1 BOOLEAN + CSV columns come through exactly as
 * better-sqlite3 yields them), runs it through the matching mapper, and asserts
 * the output shape matches the frozen API contract. Run: `npx tsx <this file>`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openDb } from '../../server/graph/db.js'
import {
  rowToEntry,
  rowToSymbol,
  rowToGraphHead,
  rowToSessionPresence,
  rowToBusMessage,
  rowToObservation,
  toBool,
  splitCsv,
} from '../../server/graph/_rows.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-rows-'))
const dbPath = path.join(tmpDir, 't.sqlite')
const db = openDb(dbPath)

let passed = 0
const check = (label: string, fn: () => void) => {
  fn()
  passed++
  console.log(`  ok  ${label}`)
}

try {
  // ── toBool / splitCsv primitives ────────────────────────────────────────────
  check('toBool coerces SQLite 0/1 + edge cases', () => {
    assert.equal(toBool(1), true)
    assert.equal(toBool(0), false)
    assert.equal(toBool(null), false)
    assert.equal(toBool(undefined), false)
    assert.equal(toBool(true), true)
    assert.equal(toBool(false), false)
    assert.equal(toBool('1'), true)
    assert.equal(toBool('true'), true)
    assert.equal(toBool(''), false)
  })

  check('splitCsv trims, drops empties', () => {
    assert.deepEqual(splitCsv('a, b ,,c'), ['a', 'b', 'c'])
    assert.deepEqual(splitCsv(''), [])
    assert.deepEqual(splitCsv(null), [])
  })

  // ── Entry ─────────────────────────────────────────────────────────────────
  db.prepare(
    `INSERT INTO entries (id,name,kind,description,content,source,scope,updatedAt,syncedAt,
       authorship,outcome,outcome_text,agent_id,session_id,machine,pinned)
     VALUES (@id,@name,@kind,@description,@content,@source,@scope,@updatedAt,@syncedAt,
       @authorship,@outcome,@outcome_text,@agent_id,@session_id,@machine,@pinned)`,
  ).run({
    id: 'mem_1',
    name: 'A Memory',
    kind: 'memory',
    description: 'desc',
    content: 'body',
    source: '/path.md',
    scope: 'user:global',
    updatedAt: 1717300000000,
    syncedAt: 1717300001000,
    authorship: 'self',
    outcome: 'success',
    outcome_text: 'worked',
    agent_id: '',
    session_id: 'sess_x',
    machine: 'node-b',
    pinned: 1,
  })

  check('rowToEntry: full row, pinned 1 → true, numeric coercion', () => {
    const row = db.prepare('SELECT * FROM entries WHERE id=?').get('mem_1') as any
    const e = rowToEntry(row)
    assert.equal(e.id, 'mem_1')
    assert.equal(e.name, 'A Memory')
    assert.equal(e.kind, 'memory')
    assert.equal(e.content, 'body')
    assert.equal(e.scope, 'user:global')
    assert.equal(e.pinned, true)
    assert.equal(typeof e.pinned, 'boolean')
    assert.equal(e.updatedAt, 1717300000000)
    assert.equal(typeof e.updatedAt, 'number')
    assert.equal(e.syncedAt, 1717300001000)
    assert.equal(e.machine, 'node-b')
  })

  check('rowToEntry: projected subset (searchEntries shape) omits absent cols', () => {
    const row = db
      .prepare(
        'SELECT id, name, kind, description, scope, source, updatedAt FROM entries WHERE id=?',
      )
      .get('mem_1') as any
    const e = rowToEntry(row)
    // present + coerced
    assert.equal(e.updatedAt, 1717300000000)
    assert.equal(typeof e.updatedAt, 'number')
    // NOT selected → must be absent (byte-compatible projection)
    assert.ok(!('content' in e), 'content must not appear when not selected')
    assert.ok(!('pinned' in e), 'pinned must not appear when not selected')
    assert.ok(!('syncedAt' in e), 'syncedAt must not appear when not selected')
    assert.deepEqual(Object.keys(e).sort(), [
      'description',
      'id',
      'kind',
      'name',
      'scope',
      'source',
      'updatedAt',
    ])
  })

  // ── Symbol ──────────────────────────────────────────────────────────────────
  db.prepare(
    `INSERT INTO symbols (id,name,symbolKind,repo,file,lang,line,signature,base,stickiness,
       centrality,lastSeen,pinned,groundTruthValid,syncedAt,machine,root,branch,commitSha,
       dirty,extractedAt,naturalId)
     VALUES (@id,@name,@symbolKind,@repo,@file,@lang,@line,@signature,@base,@stickiness,
       @centrality,@lastSeen,@pinned,@groundTruthValid,@syncedAt,@machine,@root,@branch,
       @commitSha,@dirty,@extractedAt,@naturalId)`,
  ).run({
    id: 'm@main::repo:src/x.ts#foo',
    name: 'foo',
    symbolKind: 'function',
    repo: 'repo',
    file: 'src/x.ts',
    lang: 'ts',
    line: 42,
    signature: 'foo(): void',
    base: 1.0,
    stickiness: 0.5,
    centrality: 3,
    lastSeen: 1717200000000,
    pinned: 0,
    groundTruthValid: 1,
    syncedAt: 1717200000000,
    machine: 'm',
    root: '/srv/repo',
    branch: 'main',
    commitSha: 'abc123',
    dirty: 0,
    extractedAt: 1717200000000,
    naturalId: 'repo:src/x.ts#foo',
  })

  check('rowToSymbol: booleans + numerics, groundTruthValid default true', () => {
    const row = db.prepare('SELECT * FROM symbols WHERE id=?').get('m@main::repo:src/x.ts#foo') as any
    const s = rowToSymbol(row)
    assert.equal(s.id, 'm@main::repo:src/x.ts#foo')
    assert.equal(s.name, 'foo')
    assert.equal(s.symbolKind, 'function')
    assert.equal(s.line, 42)
    assert.equal(typeof s.line, 'number')
    assert.equal(s.base, 1)
    assert.equal(s.stickiness, 0.5)
    assert.equal(s.centrality, 3)
    assert.equal(s.pinned, false)
    assert.equal(typeof s.pinned, 'boolean')
    assert.equal(s.groundTruthValid, true)
    assert.equal(typeof s.groundTruthValid, 'boolean')
    assert.equal(s.machine, 'm')
    assert.equal(s.root, '/srv/repo')
    // SymbolRow does NOT carry branch/commitSha/etc — assert exact key set
    assert.deepEqual(Object.keys(s).sort(), [
      'base',
      'centrality',
      'file',
      'groundTruthValid',
      'id',
      'lang',
      'lastSeen',
      'line',
      'machine',
      'name',
      'pinned',
      'repo',
      'root',
      'signature',
      'stickiness',
      'symbolKind',
    ])
  })

  check('rowToSymbol: groundTruthValid=0 → false; null → true', () => {
    assert.equal(rowToSymbol({ id: 'x', groundTruthValid: 0 }).groundTruthValid, false)
    assert.equal(rowToSymbol({ id: 'x' }).groundTruthValid, true)
    assert.equal(rowToSymbol({ id: 'x' }).base, 1) // base default 1
  })

  // ── GraphHead ─────────────────────────────────────────────────────────────
  db.prepare(
    `INSERT INTO graph_heads (id,repo,branch,machine,commitSha,dirty,dirtyFiles,baseBranch,extractedAt)
     VALUES (@id,@repo,@branch,@machine,@commitSha,@dirty,@dirtyFiles,@baseBranch,@extractedAt)`,
  ).run({
    id: 'repo@main@m',
    repo: 'repo',
    branch: 'main',
    machine: 'm',
    commitSha: 'abc123',
    dirty: 1,
    dirtyFiles: 'a.ts\nb.ts',
    baseBranch: 'develop',
    extractedAt: 1717200000000,
  })

  check('rowToGraphHead: dirty 1 → true', () => {
    const row = db.prepare('SELECT repo,branch,machine,commitSha,dirty,dirtyFiles,baseBranch,extractedAt FROM graph_heads WHERE id=?').get('repo@main@m') as any
    const h = rowToGraphHead(row)
    assert.equal(h.repo, 'repo')
    assert.equal(h.branch, 'main')
    assert.equal(h.dirty, true)
    assert.equal(typeof h.dirty, 'boolean')
    assert.equal(h.dirtyFiles, 'a.ts\nb.ts')
    assert.equal(h.baseBranch, 'develop')
    assert.equal(h.extractedAt, 1717200000000)
    assert.ok(!('id' in h), 'GraphHeadRow does not expose the synthetic id')
  })

  // ── SessionPresence (peer) ──────────────────────────────────────────────────
  db.prepare(
    `INSERT INTO session_meta (id,started_at,friendly_name,cwd,machine,title,last_seen,status,
       supersedes,meta_id,name_history,cadence_s,availability,mandate,assigned_by,assigned_ref)
     VALUES (@id,@started_at,@friendly_name,@cwd,@machine,@title,@last_seen,@status,
       @supersedes,@meta_id,@name_history,@cadence_s,@availability,@mandate,@assigned_by,@assigned_ref)`,
  ).run({
    id: 'sess_abc',
    started_at: 1717100000000,
    friendly_name: 'rowsmith',
    cwd: '/path/to/repos/x',
    machine: 'node-b',
    title: 'porting rows',
    last_seen: 1717100050000,
    status: 'live',
    supersedes: 'sess_old',
    meta_id: 'meta_xyz',
    name_history: 'oldname, oldername',
    cadence_s: 30,
    availability: 'available',
    mandate: 'reviewer: linkage',
    assigned_by: 'meta_pm',
    assigned_ref: 'm_dispatch1',
  })

  check('rowToSessionPresence: snake→camel renames, name_history CSV parsed', () => {
    const row = db.prepare('SELECT * FROM session_meta WHERE id=?').get('sess_abc') as any
    const p = rowToSessionPresence(row)
    assert.equal(p.sessionId, 'sess_abc')
    assert.equal(p.friendlyName, 'rowsmith')
    assert.equal(p.cwd, '/path/to/repos/x')
    assert.equal(p.machine, 'node-b')
    assert.equal(p.title, 'porting rows')
    assert.equal(p.startedAt, 1717100000000)
    assert.equal(p.lastSeen, 1717100050000)
    assert.equal(p.rawStatus, 'live')
    assert.equal(p.supersedes, 'sess_old')
    assert.equal(p.metaId, 'meta_xyz')
    assert.deepEqual(p.nameHistory, ['oldname', 'oldername'])
    // mandate-in-presence (migration 0012) — also snake→camel renames.
    assert.equal(p.cadenceS, 30)
    assert.equal(p.availability, 'available')
    assert.equal(p.mandate, 'reviewer: linkage')
    assert.equal(p.assignedBy, 'meta_pm')
    assert.equal(p.assignedRef, 'm_dispatch1')
    assert.deepEqual(Object.keys(p).sort(), [
      'assignedBy',
      'assignedRef',
      'availability',
      'cadenceS',
      'cwd',
      'friendlyName',
      'lastSeen',
      'machine',
      'mandate',
      'metaId',
      'nameHistory',
      'rawStatus',
      'sessionId',
      'startedAt',
      'supersedes',
      'title',
    ])
  })

  // ── BusMessage ────────────────────────────────────────────────────────────
  db.prepare(
    `INSERT INTO bus_messages (id,from_session,from_name,to_addr,kind,ref,body,created_at,
       delivered_to,acked_by,status,orig_to)
     VALUES (@id,@from_session,@from_name,@to_addr,@kind,@ref,@body,@created_at,
       @delivered_to,@acked_by,@status,@orig_to)`,
  ).run({
    id: 'm_1',
    from_session: 'sess_abc',
    from_name: 'rowsmith',
    to_addr: 'meta_xyz',
    kind: 'msg',
    ref: 'ref1',
    body: 'hello',
    created_at: 1717100060000,
    delivered_to: 'sess_d1, sess_d2',
    acked_by: 'sess_d1',
    status: 'open',
    orig_to: 'rowsmith',
  })

  check('rowToBusMessage: to_addr→to, CSV cols → lists', () => {
    const row = db.prepare('SELECT * FROM bus_messages WHERE id=?').get('m_1') as any
    const m = rowToBusMessage(row)
    assert.equal(m.id, 'm_1')
    assert.equal(m.fromSession, 'sess_abc')
    assert.equal(m.fromName, 'rowsmith')
    assert.equal(m.to, 'meta_xyz')
    assert.equal(m.kind, 'msg')
    assert.equal(m.ref, 'ref1')
    assert.equal(m.body, 'hello')
    assert.equal(m.createdAt, 1717100060000)
    assert.deepEqual(m.deliveredTo, ['sess_d1', 'sess_d2'])
    assert.deepEqual(m.ackedBy, ['sess_d1'])
    assert.equal(m.status, 'open')
    assert.equal(m.origTo, 'rowsmith')
  })

  check('rowToBusMessage: defaults kind→msg, status→open only on null (matches normMsg `?? `)', () => {
    // bus.ts normMsg uses String(r.kind ?? 'msg') — the default fires on
    // null/undefined ONLY, NOT on empty string. Byte-compatibility demands the
    // same: a missing column defaults; an explicit '' passes through.
    const m = rowToBusMessage({ id: 'm_2' })
    assert.equal(m.kind, 'msg')
    assert.equal(m.status, 'open')
    assert.deepEqual(m.deliveredTo, [])
    assert.deepEqual(m.ackedBy, [])
    // explicit empty string passes through (NOT replaced by the default)
    const m2 = rowToBusMessage({ id: 'm_3', kind: '', status: '' })
    assert.equal(m2.kind, '')
    assert.equal(m2.status, '')
  })

  // ── Observation ─────────────────────────────────────────────────────────────
  db.prepare(
    `INSERT INTO observation_meta (id,trend,evidence_count,first_observed,last_observed,observer,pinned)
     VALUES (@id,@trend,@evidence_count,@first_observed,@last_observed,@observer,@pinned)`,
  ).run({
    id: 'obs_1',
    trend: 'strengthening',
    evidence_count: 4,
    first_observed: 1717000000000,
    last_observed: 1717100000000,
    observer: 'self',
    pinned: 1,
  })

  check('rowToObservation: entry × observation_meta join shape', () => {
    // simulate the joined row the route produces
    const meta = db.prepare('SELECT * FROM observation_meta WHERE id=?').get('obs_1') as any
    const joined = {
      id: meta.id,
      name: 'Always refine the workshop',
      description: 'a derived trend',
      scope: 'user:global',
      updatedAt: 1717100000000,
      trend: meta.trend,
      evidence_count: meta.evidence_count,
      first_observed: meta.first_observed,
      last_observed: meta.last_observed,
      observer: meta.observer,
      pinned: meta.pinned,
    }
    const o = rowToObservation(joined)
    assert.equal(o.id, 'obs_1')
    assert.equal(o.name, 'Always refine the workshop')
    assert.equal(o.trend, 'strengthening')
    assert.equal(o.evidence_count, 4)
    assert.equal(typeof o.evidence_count, 'number')
    assert.equal(o.first_observed, 1717000000000)
    assert.equal(o.last_observed, 1717100000000)
    assert.equal(o.observer, 'self')
    assert.equal(o.pinned, true)
    assert.equal(typeof o.pinned, 'boolean')
    assert.equal(o.updatedAt, 1717100000000)
    assert.ok(!('evidence' in o), 'evidence is attached by the caller, not the mapper')
  })

  check('rowToObservation: defaults trend→stable, observer null→self', () => {
    const o = rowToObservation({ id: 'obs_x', observer: null })
    assert.equal(o.trend, 'stable')
    assert.equal(o.observer, 'self')
    assert.equal(o.pinned, false)
    // empty-string observer passes through (matches route's `?? 'self'`)
    assert.equal(rowToObservation({ id: 'obs_y', observer: '' }).observer, '')
  })

  console.log(`\nPASS — ${passed} checks`)
} finally {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
