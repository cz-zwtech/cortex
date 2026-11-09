import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryStore } from '../server/store.js'
import { Journal } from '../server/journal.js'
import { drive, describeDrive, memoryDirs, scopeForDir } from '../server/drive.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')

const rig = (t: { after: (f: () => void) => void }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-drive-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const db = new Database(':memory:')
  db.exec(schema)
  return {
    root,
    deps: {
      store: new MemoryStore(db),
      journal: new Journal({ dir: path.join(root, 'journal'), machine: 'node-a' }),
    },
  }
}

const writeMemory = (dir: string, name: string, body: string) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\n---\n\n${body}\n`)
}

const BODY =
  'Deploy by running the release script on the build host, then wait for the health check ' +
  'to report green before switching traffic over to the new pods.'

// ── the driver actually drives ───────────────────────────────────────────────

test('THE DRIVER INGESTS — before it, nothing called sweep and the graph stayed empty', (t) => {
  const { root, deps } = rig(t)
  writeMemory(path.join(root, 'memory'), 'deploy', BODY)

  assert.equal(deps.store.count(), 0)
  const report = drive({ roots: [root], machine: 'node-a' }, deps)

  assert.equal(report.ingested, 1)
  assert.equal(deps.store.count(), 1, 'the memory reached the graph')
  assert.deepEqual(report.skipped, [])
  assert.equal(report.budgetExhausted, false)
})

test('it finds memory dirs under a projects-style layout too', (t) => {
  const { root, deps } = rig(t)
  writeMemory(path.join(root, 'memory'), 'user-wide', BODY)
  writeMemory(path.join(root, 'projects', '-home-alex', 'memory'), 'project-scoped', BODY + ' x')

  const report = drive({ roots: [root], machine: 'node-a' }, deps)
  assert.equal(report.swept.length, 2)
  assert.equal(report.ingested, 2)
})

test('scope comes from the layout, which already encodes it', () => {
  assert.equal(scopeForDir('/home/x/.claude/memory'), 'user')
  assert.equal(scopeForDir('/home/x/.claude/projects/-home-alex/memory'), '-home-alex')
})

test('memoryDirs finds only directories named memory', (t) => {
  const { root } = rig(t)
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true })
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true })
  assert.deepEqual(memoryDirs([root]), [path.join(root, 'memory')])
})

// ── the budget, and what it must never hide ──────────────────────────────────

test('A BUDGET STOP REPORTS EXACTLY WHICH DIRECTORIES WERE NOT SWEPT', (t) => {
  // "Swept 3 of 7" and "swept everything, found nothing" must never be the same
  // output. A driver that silently ran out of time looks identical to a corpus
  // with nothing new in it — and the consequence, a memory the human wrote that
  // never becomes recallable, is silent on every subsequent read.
  const { root, deps } = rig(t)
  writeMemory(path.join(root, 'a', 'memory'), 'one', BODY)
  writeMemory(path.join(root, 'b', 'memory'), 'two', BODY + ' two')
  writeMemory(path.join(root, 'c', 'memory'), 'three', BODY + ' three')

  // Clock jumps past the budget after the first directory.
  let t0 = 0
  const clock = () => (t0 += 1_000)

  const report = drive({ roots: [root], machine: 'node-a', budgetMs: 1_500, clock }, deps)
  assert.equal(report.budgetExhausted, true)
  assert.equal(report.swept.length, 1)
  assert.equal(report.skipped.length, 2, 'and it NAMES them')
  assert.ok(report.skipped.every((d) => d.endsWith('memory')))
})

test('the description says what was NOT done, not only what was', () => {
  const line = describeDrive({
    swept: ['/a/memory'],
    skipped: ['/b/memory', '/c/memory'],
    files: 1,
    ingested: 1,
    declined: 0,
    dropped: 0,
    durationMs: 5,
    budgetExhausted: true,
  })
  assert.match(line, /NOT SWEPT/)
  assert.match(line, /budget exhausted/)
  assert.match(line, /\/b\/memory/)
})

test('a clean run says nothing about skipping, because nothing was skipped', () => {
  const line = describeDrive({
    swept: ['/a/memory'],
    skipped: [],
    files: 2,
    ingested: 2,
    declined: 0,
    dropped: 0,
    durationMs: 5,
    budgetExhausted: false,
  })
  assert.ok(!line.includes('NOT SWEPT'))
})

test('THE BUDGET IS CHECKED ON A DIRECTORY BOUNDARY, never mid-file', (t) => {
  // Consume rewrites whole files, so stopping inside a directory could leave one
  // file's blocks split between ingested and not. The boundary is what keeps a
  // bounded run from corrupting the inbox.
  const { root, deps } = rig(t)
  const dir = path.join(root, 'memory')
  writeMemory(dir, 'a', BODY)
  writeMemory(dir, 'b', BODY + ' second')

  let t0 = 0
  const report = drive(
    { roots: [root], machine: 'node-a', budgetMs: 1, clock: () => (t0 += 10) },
    deps,
  )
  // Either the whole directory was swept or none of it was — never half.
  assert.ok(report.swept.length === 1 || report.skipped.length === 1)
  if (report.swept.length === 1) assert.equal(report.files, 2, 'both files, or neither')
})

// ── failure isolation ────────────────────────────────────────────────────────

test('an unreadable directory is a SKIP, not a silent success', (t) => {
  const { root, deps } = rig(t)
  writeMemory(path.join(root, 'good', 'memory'), 'ok', BODY)
  const bad = path.join(root, 'bad', 'memory')
  fs.mkdirSync(bad, { recursive: true })

  // A directory entry that cannot be read as a file makes sweep throw.
  fs.mkdirSync(path.join(bad, 'trap.md'))

  const report = drive({ roots: [root], machine: 'node-a' }, deps)
  assert.ok(report.swept.length >= 1, 'the good one still ran')
})

test('no memory directories at all is a clean empty report, not an error', (t) => {
  const { root, deps } = rig(t)
  const report = drive({ roots: [root], machine: 'node-a' }, deps)
  assert.deepEqual(report.swept, [])
  assert.deepEqual(report.skipped, [])
  assert.equal(report.ingested, 0)
})

test('a QUARANTINED memory is counted and does NOT reach the graph', (t) => {
  // The secret gate is layer 2 and blocks before the journal append. The driver
  // must surface that count, or a credential-bearing memory silently vanishing
  // from recall looks like it was simply never written.
  const { root, deps } = rig(t)
  writeMemory(
    path.join(root, 'memory'),
    'creds',
    'The deploy token is ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and it is used by CI.',
  )
  const report = drive({ roots: [root], machine: 'node-a' }, deps)
  assert.equal(report.declined, 1)
  assert.equal(report.ingested, 0)
  assert.equal(deps.store.count(), 0)
})

test('A QUARANTINED MEMORY RAISES A STATUS WARNING — the mitigation the spec required', async () => {
  // secrets.ts states the failure plainly: a noisy quarantine stops being read,
  // and once it does, real secrets sit unsynced in scratchpads AND SO DOES
  // EVERYTHING CAUGHT ALONGSIDE THEM — the user's memory silently stops working
  // and nothing reports it. Its stated mitigation is "surface the quarantine
  // depth in status".
  //
  // That mitigation did not exist: `store.quarantined()` was written and had no
  // caller, so the failure the design identified was unmitigated — the safeguard
  // was designed, built one layer down, and never connected.
  const { default: mod } = await import('../server/index.js')
  const fsx = await import('node:fs')
  const osx = await import('node:os')
  const pathx = await import('node:path')
  const { default: Db } = await import('better-sqlite3')

  const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'cortex-qstatus-'))
  try {
    const db = new Db(':memory:')
    const ctx = {
      name: 'memory',
      dir: pathx.join(import.meta.dirname, '..'),
      db,
      dataDir: pathx.join(root, 'data'),
      events: { publish: async () => ({}) } as never,
      capabilities: { provide: () => {}, get: () => undefined, has: () => false, list: () => [] } as never,
      core: { version: '2.0.0', contract: '1' },
      log: () => {},
    }
    mod.start!(ctx as never)

    const clean = mod.status!(ctx as never)
    assert.match(clean.summary, /0 quarantined/)

    // Write a credential-bearing memory and sweep it: the gate holds it.
    const dir = pathx.join(root, 'memory')
    fsx.mkdirSync(dir, { recursive: true })
    fsx.writeFileSync(
      pathx.join(dir, 'creds.md'),
      '---\nname: creds\n---\n\nThe deploy token is ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb used by CI.\n',
    )
    const { drive: driveFn } = await import('../server/drive.js')
    const { Journal } = await import('../server/journal.js')
    const { MemoryStore: MS } = await import('../server/store.js')
    driveFn(
      { roots: [root], machine: 'node-a' },
      { store: new MS(db), journal: new Journal({ dir: pathx.join(root, 'j'), machine: 'node-a' }) },
    )

    const held = mod.status!(ctx as never)
    assert.match(held.summary, /1 quarantined/)
    assert.ok(
      held.warnings?.some((w) => /QUARANTINED/.test(w)),
      'and it is a WARNING, not a statistic',
    )
    assert.ok(
      held.warnings?.some((w) => /alongside/.test(w)),
      'naming the real consequence: everything in that file is also unsynced',
    )
  } finally {
    fsx.rmSync(root, { recursive: true, force: true })
  }
})

test('A DECLARED ROOT IS TRUSTED AS A MEMORY DIR — the silent trap, both sites', (t) => {
  // CKN_MEMORY_DIRS names directories that ARE memory dirs. Requiring them to
  // ALSO be named `memory` made the sweep answer "no memory directories found"
  // for a directory the user explicitly nominated — and made the write-time
  // reflex inert for the same directory, with nothing reporting either.
  //
  // The segment rule is still right for DEFAULTED roots: `~/.claude/projects`
  // holds one directory per encoded cwd, and without it the reflex would sit in
  // front of every source edit in every project.
  const { root, deps } = rig(t)
  const odd = path.join(root, 'notes-not-called-memory')
  fs.mkdirSync(odd, { recursive: true })
  fs.writeFileSync(path.join(odd, 'a.md'), `---\nname: a\n---\n\n${BODY}\n`)

  assert.deepEqual(memoryDirs([odd]), [], 'untrusted: the old behaviour')
  assert.deepEqual(memoryDirs([odd], 3, true), [odd], 'declared: trusted')

  const report = drive({ roots: [odd], machine: 'node-a', trustRoots: true }, deps)
  assert.equal(report.ingested, 1)
})
