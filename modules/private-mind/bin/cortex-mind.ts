#!/usr/bin/env tsx
/**
 * cortex-mind: private mind on this node.
 *
 *   cortex-mind status [--json] [--all-held]
 *   cortex-mind dry-run [--local-roles a,b] [--local-dirs /p,/q] [--json] [--all-held]
 *   cortex-mind sync                    one round now, take the answers, exit (what session hooks start
 *                                       on a node with no long-running host); one at a time
 *   cortex-mind remove                  before taking the module out: off on this node, its mind member leaves
 *                                       comms, and what stays on disk is listed (nothing is deleted)
 *   cortex-mind explain <machine:seq>   why the secret gate holds a record: each finding with the
 *                                       flagged token's shape (first 2 chars, length, classes), never the token
 *
 * Held records are listed by id and slug, never content: up to 20 per reason,
 * or all of them with --all-held.
 *
 * status: this node's mind config and sync state, read only.
 *
 * What a first full sync would send from this node, counted by outcome and by
 * scope, without sending anything. It never opens the real stores: the
 * journal, the context store, comms' identity and the mesh log are copied into
 * a private temporary directory (SQLite through its backup API, so a live
 * store copies consistently), the same code the bundle builder uses runs on
 * the copy, and the copy is deleted.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const argv = process.argv.slice(2)
const arg = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined)
const list = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined)
const die = (m: string): never => {
  console.error(`cortex-mind: ${m}`)
  process.exit(2)
}

const USAGE = 'usage: cortex-mind status [--json] [--all-held] | sync | remove | dry-run [--local-roles a,b] [--local-dirs /p,/q] [--json] [--all-held] | explain <machine:seq>'

/** Held records, by reason: id and slug only. */
const heldLines = (held: { record: string; code: string; slug?: string | null }[]): string[] => {
  const per = argv.includes('--all-held') ? Infinity : 20
  const out: string[] = []
  for (const code of [...new Set(held.map((h) => h.code))].sort()) {
    const of = held.filter((h) => h.code === code)
    for (const h of of.slice(0, per)) out.push(`  ${code.padEnd(12)} ${h.record}  ${h.slug ?? '(no slug)'}`)
    if (of.length > per) out.push(`  ${code.padEnd(12)} ... and ${of.length - per} more (--all-held)`)
  }
  return out
}

/**
 * Memory's and comms' capabilities, as any CLI gets them: the modules started in this process
 * (never the host-only ones), on whatever state dir is set. The way in to other modules, not their files.
 */
const withModules = async <T>(fn: (cap: <C>(id: string) => C) => Promise<T>): Promise<T> => {
  const { dataRoot, modulesDir, dbPath } = await import('../../../core/paths.js')
  const { Lifecycle } = await import('../../../core/lifecycle.js')
  const { EventBus } = await import('../../../core/events.js')
  const { Storage } = await import('../../../core/storage.js')
  const storage = new Storage(dbPath())
  const lc = new Lifecycle({ modulesDir: modulesDir(), dataRoot: dataRoot(), dbPath: storage.path, events: new EventBus(), storage, log: () => {} })
  await lc.run()
  try {
    return await fn(<C>(id: string) => lc.capabilities.get<C>(id) ?? die(`${id} is not available: is ${id.split('.')[0]} installed?`))
  } finally {
    await lc.stopAll()
    storage.close()
  }
}

if (argv[0] === 'status') {
  const { dataRoot } = await import('../../../core/paths.js')
  const { loadConfig } = await import('../server/config.js')
  const { loadState } = await import('../server/state.js')
  const { short } = await import('../server/commits.js')
  const dir = path.join(dataRoot(), 'private-mind')
  let cfg
  try {
    cfg = loadConfig(dir)
  } catch (err) {
    die((err as Error).message)
  }
  const s = loadState(dir)
  const counts = { waiting: 0, givenUp: 0, pointers: 0, keptHome: 0 }
  const heldByCode: Record<string, number> = {}
  const writers: Record<string, number> = {}
  const heldRows: { record: string; code: string; slug?: string | null }[] = []
  const dbFile = path.join(dir, 'mind.sqlite')
  if (fs.existsSync(dbFile)) {
    const db = new Database(dbFile, { readonly: true, fileMustExist: true })
    try {
      const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
      counts.waiting = n("SELECT COUNT(*) n FROM writers WHERE state = 'pending'")
      counts.givenUp = n("SELECT COUNT(*) n FROM writers WHERE state = 'unresolvable'")
      counts.pointers = n('SELECT COUNT(*) n FROM pointers')
      counts.keptHome = n('SELECT COUNT(*) n FROM kept')
      for (const r of db.prepare('SELECT state, COUNT(*) n FROM writers GROUP BY state').all() as { state: string; n: number }[]) writers[r.state] = r.n
      try {
        for (const r of db.prepare('SELECT code, COUNT(*) n FROM held GROUP BY code').all() as { code: string; n: number }[]) heldByCode[r.code] = r.n
        heldRows.push(...(db.prepare('SELECT * FROM held ORDER BY code, record').all() as { record: string; code: string; slug?: string | null }[]))
      } catch {
        /* a store from before held reasons were kept */
      }
    } finally {
      db.close()
    }
  }
  const report = {
    configured: !!cfg,
    enabled: cfg?.enabled ?? false,
    central: cfg?.central,
    archival: cfg?.archival,
    head: s.commits[0]?.id,
    base: s.base,
    degraded: s.degraded,
    lastSyncAt: s.lastSyncAt,
    writersWaiting: counts.waiting,
    writersGivenUp: counts.givenUp,
    pointersHeld: counts.pointers,
    memoriesKeptHome: counts.keptHome,
    heldLastBundle: heldByCode,
    held: heldRows.map((h) => ({ record: h.record, code: h.code, slug: h.slug ?? undefined })),
    writersByState: writers,
  }
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else if (!cfg) console.log(`private mind: not configured (no ${path.join(dir, 'mind.json')}); nothing syncs`)
  else {
    console.log(`private mind: ${cfg.enabled ? 'ENABLED' : 'configured, not enabled (nothing syncs until enabled)'}`)
    console.log(`central: ${cfg.central ?? 'unset'}${cfg.archival ? `; archival: ${cfg.archival}` : ''}`)
    console.log(`at: ${s.commits[0] ? short(s.commits[0].id) : 'no sync yet'}${s.base ? `, on central ${short(s.base)}` : ''}${s.degraded ? '  DEGRADED (central away; synced from a peer)' : ''}`)
    console.log(`last sync: ${s.lastSyncAt ? `${new Date(s.lastSyncAt).toISOString().slice(0, 16)}Z` : 'never'}`)
    console.log(`writers waiting: ${counts.waiting}; given up: ${counts.givenUp}; kept home: ${counts.keptHome}; pointers held from others: ${counts.pointers}`)
    console.log(`writers by state: ${Object.keys(writers).length ? Object.entries(writers).map(([k, v]) => `${k} ${v}${k === 'unbound' ? ' (wrote while in no comms role; synced like any other)' : ''}`).join(', ') : 'none yet'}`)
    console.log(`held back by the last bundle: ${Object.keys(heldByCode).length ? Object.entries(heldByCode).map(([k, v]) => `${k} ${v}`).join(', ') : 'nothing'}`)
    for (const l of heldLines(heldRows)) console.log(l)
  }
  process.exit(0)
}

if (argv[0] === 'remove') {
  const { dataRoot } = await import('../../../core/paths.js')
  const { machineId } = await import('../../../core/machineId.js')
  const { MIND_ROLE } = await import('../server/service.js')
  const dir = path.join(dataRoot(), 'private-mind')
  const file = path.join(dir, 'mind.json')
  if (fs.existsSync(file)) {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
    fs.writeFileSync(file, JSON.stringify({ ...cfg, enabled: false }, null, 2) + '\n')
    console.log(`off on this node: ${file} says enabled: false`)
  }
  const member = `mind-${machineId()}`
  await withModules(async (cap) => {
    await cap<(role: string, member: string) => Promise<unknown>>('comms.leaveRole')(MIND_ROLE, member)
  })
  console.log(`${member} left role ${MIND_ROLE}`)
  const left = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  console.log(`left on disk, yours to keep or delete: ${left.length ? `${dir} (${left.join(', ')})` : 'nothing'}`)
  console.log("the mesh's last mind-state record for this node stays in the log until the node is forgotten; nothing reads it once the module is gone")
  process.exit(0)
}

if (argv[0] === 'explain') {
  const [machine, seqText] = (argv[1] ?? '').split(/:(?=\d+$)/)
  const seq = Number(seqText)
  if (!machine || !Number.isInteger(seq)) die('usage: cortex-mind explain <machine:seq>')
  const { scanForSecrets } = await import('../../../core/secrets.js')
  const r = await withModules(async (cap) =>
    cap<(since: Record<string, number>) => { machine: string; seq: number }[]>('memory.journalStream')({}).find((x) => x.machine === machine && x.seq === seq),
  )
  if (!r) die(`no record ${machine}:${seq} in this journal`)
  // Judged as the bundle line carries it, which is what the receiver's gate reads.
  const findings = scanForSecrets(JSON.stringify({ t: 'record', r }), { explain: true })
  console.log(`${machine}:${seq} ${(r as { slug?: string }).slug ?? ''}: ${findings.length ? `${findings.length} finding(s)` : 'nothing the gate would refuse'}`)
  for (const f of findings) console.log(`  ${f.kind}: ${f.hint}${f.shape ? `; token ${f.shape}` : ''}`)
  process.exit(0)
}

if (argv[0] === 'sync') {
  const { dataRoot, modulesDir, dbPath } = await import('../../../core/paths.js')
  const { Lifecycle } = await import('../../../core/lifecycle.js')
  const { EventBus } = await import('../../../core/events.js')
  const { Storage } = await import('../../../core/storage.js')
  const { ONESHOT_ENV, releaseLock, takeLock } = await import('../server/oneshot.js')
  const dir = path.join(dataRoot(), 'private-mind')
  const at = () => new Date().toISOString().slice(0, 19) + 'Z'
  if (!takeLock(dir)) {
    console.log(`${at()} sync: another one-shot is running; nothing to do`)
    process.exit(0)
  }
  process.env[ONESHOT_ENV] = '1'
  const storage = new Storage(dbPath())
  // Memory, comms and mesh as any CLI starts them; of the host-only modules, private mind alone (never telegram).
  const lc = new Lifecycle({ modulesDir: modulesDir(), dataRoot: dataRoot(), dbPath: storage.path, events: new EventBus(), storage, host: true, hostModules: ['private-mind'], log: () => {} })
  let code = 0
  try {
    await lc.run()
    const once = lc.capabilities.get<() => Promise<Record<string, unknown>>>('private-mind.syncOnce')
    const r = once ? await once() : { ran: false, why: lc.statuses.find((m) => m.name === 'private-mind')?.reason ?? 'private mind did not start' }
    console.log(`${at()} sync: ${JSON.stringify({ ...r, started: lc.statuses.filter((m) => m.state === 'started').map((m) => m.name) })}`)
    if (r.refused) code = 1
  } catch (err) {
    console.log(`${at()} sync failed: ${(err as Error).message}`)
    code = 1
  } finally {
    await lc.stopAll()
    releaseLock(dir)
  }
  process.exit(code)
}

if (argv[0] !== 'dry-run') die(USAGE)

const { stateDir } = await import('../../../core/paths.js')
const real = stateDir()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mind-dryrun-'))
fs.chmodSync(tmp, 0o700)

/** A consistent copy of a live SQLite file, read only at the source. */
const copyDb = async (from: string, to: string) => {
  if (!fs.existsSync(from)) return
  fs.mkdirSync(path.dirname(to), { recursive: true })
  const src = new Database(from, { readonly: true, fileMustExist: true })
  try {
    await src.backup(to)
  } finally {
    src.close()
  }
}
const copyTree = (from: string, to: string, skip: (f: string) => boolean = () => false) => {
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, filter: (f) => !skip(f) })
}

try {
  const data = path.join(real, 'data')
  const sqlite = (f: string) => /\.sqlite(-wal|-shm)?$/.test(f)
  if (fs.existsSync(path.join(real, 'machine-id'))) fs.copyFileSync(path.join(real, 'machine-id'), path.join(tmp, 'machine-id'))
  copyTree(path.join(data, 'memory', 'journal'), path.join(tmp, 'data', 'memory', 'journal'), (f) => f.endsWith('.lock'))
  await copyDb(path.join(data, 'memory', 'context.sqlite'), path.join(tmp, 'data', 'memory', 'context.sqlite'))
  copyTree(path.join(data, 'comms'), path.join(tmp, 'data', 'comms'))
  copyTree(path.join(data, 'mesh'), path.join(tmp, 'data', 'mesh'), (f) => sqlite(f) || f.includes(`${path.sep}files`) || f.endsWith('daemon.pid'))
  await copyDb(path.join(data, 'mesh', 'mesh.sqlite'), path.join(tmp, 'data', 'mesh', 'mesh.sqlite'))
  copyTree(path.join(data, 'private-mind'), path.join(tmp, 'data', 'private-mind'), sqlite)
  await copyDb(path.join(data, 'private-mind', 'mind.sqlite'), path.join(tmp, 'data', 'private-mind', 'mind.sqlite'))

  // From here on every path resolves inside the copy; the modules are still the installed ones.
  const { modulesDir } = await import('../../../core/paths.js')
  process.env.CKN_MODULES_DIR = modulesDir()
  process.env.CKN_STATE_DIR = tmp
  delete process.env.CKN_MESH_DIR
  delete process.env.CKN_DB_PATH

  const { machineId } = await import('../../../core/machineId.js')
  const { MindConfigSchema, loadConfig } = await import('../server/config.js')
  const { MindStore } = await import('../server/store.js')
  const { makeBundle } = await import('../server/sync.js')

  const self = machineId()
  const mindDir = path.join(tmp, 'data', 'private-mind')
  const base = loadConfig(mindDir) ?? MindConfigSchema.parse({})
  const cfg = MindConfigSchema.parse({ ...base, ...(list(arg('--local-roles')) ? { localRoles: list(arg('--local-roles')) } : {}), ...(list(arg('--local-dirs')) ? { localDirs: list(arg('--local-dirs')) } : {}) })
  const mind = new MindStore(mindDir)
  await withModules(async (cap) => {
  // Read through the modules' capabilities on the copy; nothing is adopted.
  const ports = {
    versionVector: cap<() => Record<string, number>>('memory.versionVector'),
    journalStream: cap<(since: Record<string, number>) => never>('memory.journalStream'),
    journalAdopt: () => ({ added: 0, rejected: 0 }),
    blockVector: cap<() => Record<string, number>>('memory.blockVector'),
    blockStream: (since: Record<string, number>) => cap<(s: Record<string, number>, limit?: number) => never>('memory.blockStream')(since, 1_000_000),
    blockAdopt: () => ({ added: 0, updated: 0, rejected: 0 }),
    sessionRoles: cap<(s: string) => Promise<never>>('comms.sessionRoles'),
    sessionInfo: cap<(s: string) => never>('memory.sessionInfo'),
    shapeOf: cap<(c: string) => string>('memory.shapeOf'),
  }
  const own = (ports.journalStream({}) as { kind: string; machine: string; seq: number; scope?: string }[]).filter((r) => r.machine === self && r.kind === 'memory')
  const scopeOf = new Map(own.map((r) => [`${r.machine}:${r.seq}`, r.scope ?? '?']))
  const b = await makeBundle({ ports, store: mind, cfg, self, since: { vv: {}, bvv: {} } })

  type Count = Record<string, number>
  const total: Count = {}
  const byScope: Record<string, Count> = {}
  const add = (outcome: string, scope: string) => {
    total[outcome] = (total[outcome] ?? 0) + 1
    ;(byScope[scope] ??= {})[outcome] = (byScope[scope]![outcome] ?? 0) + 1
  }
  for (const l of b.lines) {
    if (l.t === 'record' && l.r.machine === self && l.r.kind === 'memory') add('ship', l.r.scope ?? '?')
    if (l.t === 'pointer' && l.p.owner.node === self) add('pointer', scopeOf.get(l.p.memory) ?? '?')
  }
  const outcomeOf: Record<string, string> = { 'local-role': 'held-local-role', 'local-place': 'held-local-place', waiting: 'held-unknown', 'given-up': 'given-up', 'secret-gate': 'held-secret-gate' }
  for (const h of b.held) if (h.record.startsWith(`${self}:`)) add(outcomeOf[h.code] ?? h.code, h.scope ?? '?')
  // This node's own gaps only: those passed on from other nodes are theirs.
  const deletionGaps = b.lines.filter((l) => l.t === 'record' && l.r.kind === 'gap' && l.r.machine === self).length - b.held.filter((h) => h.code !== 'waiting').length - b.lines.filter((l) => l.t === 'pointer' && l.p.owner.node === self).length
  const ownBlocks = (ports.blockStream({}) as { machine: string }[]).filter((x) => x.machine === self).length
  const shippedBlocks = b.lines.filter((l) => l.t === 'block' && l.b.machine === self).length
  const reasons: Count = {}
  for (const h of b.held) reasons[h.why.replace(/session [0-9a-f-]{8}/, 'session …')] = (reasons[h.why.replace(/session [0-9a-f-]{8}/, 'session …')] ?? 0) + 1

  const report = {
    node: self,
    rules: { localRoles: cfg.localRoles, localDirs: cfg.localDirs, workingShapes: cfg.working.shapes },
    memories: own.length,
    outcomes: total,
    deletionsWithheld: Math.max(0, deletionGaps),
    blocks: { own: ownBlocks, wouldShip: shippedBlocks },
    topReasons: Object.entries(reasons).sort((x, y) => y[1] - x[1]).slice(0, 8),
    held: b.held.filter((h) => h.record.startsWith(`${self}:`)).map((h) => ({ record: h.record, code: h.code, ...(h.slug ? { slug: h.slug } : {}) })),
    byScope,
    note: 'held-unknown counts writers comms cannot place now; after 24 h a real sync gives them up (held for good, sent as gaps)',
  }
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`dry run on a copy of ${self}'s stores; nothing was sent or changed`)
    console.log(`rules: localRoles [${cfg.localRoles.join(', ')}], localDirs [${cfg.localDirs.join(', ')}], working shapes [${cfg.working.shapes.join(', ')}]`)
    console.log(`memories of this node: ${own.length}`)
    for (const [k, v] of Object.entries(total).sort()) console.log(`  ${k.padEnd(18)} ${v}`)
    console.log(`deletions/redactions withheld (their target stayed home): ${report.deletionsWithheld}`)
    console.log(`dialogue blocks: ${shippedBlocks} of ${ownBlocks} would go`)
    console.log('held, by id and slug:')
    for (const l of heldLines(b.held.filter((h) => h.record.startsWith(`${self}:`)))) console.log(l)
    console.log('top reasons held:')
    for (const [why, n] of report.topReasons) console.log(`  ${String(n).padStart(5)}  ${why}`)
    console.log('by scope:')
    for (const [scope, c] of Object.entries(byScope).sort((x, y) => Object.values(y[1]).reduce((a, n) => a + n, 0) - Object.values(x[1]).reduce((a, n) => a + n, 0)))
      console.log(`  ${scope.padEnd(40)} ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')}`)
    console.log(report.note)
  }
  })
  mind.close()
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
