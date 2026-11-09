/**
 * The Phase 2 exit bar, as executable tests.
 *
 *   1. the scaffold boots with ZERO modules and reports healthy
 *   2. a module dropped into the modules dir is discovered, registers, appears
 *   3. removing it makes it vanish
 *   4. the compat check exists and refuses incompatible mods BEFORE they run
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { EventBus } from '../core/events.js'
import { Storage } from '../core/storage.js'
import { Lifecycle } from '../core/lifecycle.js'
import { buildStatus } from '../core/status.js'

const REPO = path.resolve(import.meta.dirname, '..')

const scratch = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-lab-test-'))
  return {
    root,
    modulesDir: path.join(root, 'modules'),
    dataRoot: path.join(root, 'data'),
    dbPath: path.join(root, 'cortex.sqlite'),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

const boot = async (s: Awaited<ReturnType<typeof scratch>>) => {
  const events = new EventBus()
  const storage = new Storage(s.dbPath)
  const lifecycle = new Lifecycle({
    modulesDir: s.modulesDir,
    dataRoot: s.dataRoot,
    dbPath: s.dbPath,
    events,
    storage,
  })
  await lifecycle.run()
  return {
    lifecycle,
    events,
    storage,
    status: buildStatus({ lifecycle, events, storage, modulesDir: s.modulesDir }),
  }
}

/** Install the example module by symlinking it into a scratch modules dir. */
const installHelloWorld = async (modulesDir: string) => {
  await fs.mkdir(modulesDir, { recursive: true })
  await fs.symlink(
    path.join(REPO, 'examples', 'hello-world'),
    path.join(modulesDir, 'hello-world'),
    'dir',
  )
}

test('EXIT BAR 1: scaffold boots with zero modules and reports healthy', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)

  const { status } = await boot(s)

  assert.equal(status.core.status, 'healthy')
  assert.deepEqual(status.modules.started, [])
  assert.deepEqual(status.modules.blocked, [])
  assert.deepEqual(status.modules.failed, [])
  assert.deepEqual(status.capabilities, [])
  // "Says what it is missing" — the naked scaffold must tell you where mods go.
  assert.match(status.notes.join(' '), /No modules installed/)
  assert.match(status.notes.join(' '), /modules/i)
})

test('EXIT BAR 1b: a zero-module scaffold never opens a database', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)

  const { status } = await boot(s)

  // This is what makes "amenities are zero-overhead when unused" checkable
  // rather than a slogan.
  assert.equal(status.core.storage, 'not opened')
  await assert.rejects(fs.access(s.dbPath), 'no database file should exist on disk')
})

test('EXIT BAR 1c: a missing modules directory is normal, not an error', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  // Note: scratch() never creates modulesDir. Booting must still succeed.
  const { status } = await boot(s)
  assert.equal(status.core.status, 'healthy')
})

test('EXIT BAR 2: a module dropped in is discovered, starts, and appears', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  await installHelloWorld(s.modulesDir)

  const { status, lifecycle } = await boot(s)

  assert.deepEqual(status.modules.started, ['hello-world'])
  assert.equal(status.modules.blocked.length, 0)
  assert.equal(status.modules.failed.length, 0, JSON.stringify(status.modules.failed))
  assert.deepEqual(status.capabilities, ['hello-world.greet'])

  // The capability actually works through the registry.
  const greet = lifecycle.capabilities.get<(who?: string) => string>('hello-world.greet')
  assert.equal(typeof greet, 'function')
  assert.equal(greet!('cortex'), 'hello, cortex')
})

test('EXIT BAR 2b: the module subscribes without registering a harness hook', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  await installHelloWorld(s.modulesDir)

  const { events, status } = await boot(s)

  assert.deepEqual(status.events.topics, ['SessionStart'])
  assert.equal(events.count('SessionStart'), 1)

  const result = await events.publish('SessionStart', { session: 'abc' })
  assert.equal(result.delivered, 1)
  assert.equal(result.failures.length, 0)
  // Results are paired with their module so a failing subscriber cannot shift
  // attribution of everything after it.
  assert.equal(result.results[0]?.module, 'hello-world')
  assert.deepEqual(result.results[0]?.value, { module: 'hello-world', saw: { session: 'abc' } })
})

test('EXIT BAR 3: removing the module makes it vanish', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  await installHelloWorld(s.modulesDir)

  const first = await boot(s)
  assert.deepEqual(first.status.modules.started, ['hello-world'])

  await fs.rm(path.join(s.modulesDir, 'hello-world'), { recursive: true, force: true })

  const second = await boot(s)
  assert.deepEqual(second.status.modules.started, [])
  assert.deepEqual(second.status.capabilities, [])
  assert.deepEqual(second.status.events.topics, [])
})

test('EXIT BAR 4: an incompatible module is refused BEFORE its code runs', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)

  const dir = path.join(s.modulesDir, 'from-the-future')
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'module.json'),
    JSON.stringify({ name: 'from-the-future', version: '1.0.0', requiresCore: '>=9.0.0' }),
  )
  // If this module were ever imported, the throw would surface as `failed`
  // rather than `blocked` — which is exactly the distinction being tested.
  await fs.writeFile(
    path.join(dir, 'server', 'index.ts'),
    `throw new Error('module code must not execute when refused')`,
  )

  const { status } = await boot(s)

  assert.deepEqual(status.modules.started, [])
  assert.equal(status.modules.failed.length, 0, 'refusal must happen before execution')
  assert.equal(status.modules.blocked.length, 1)
  assert.match(status.modules.blocked[0]!.reason, /requires core >=9\.0\.0/)
})

test('a malformed manifest is rejected without stopping other modules', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  await installHelloWorld(s.modulesDir)

  const bad = path.join(s.modulesDir, 'broken')
  await fs.mkdir(bad, { recursive: true })
  await fs.writeFile(path.join(bad, 'module.json'), '{ this is not json')

  const { status } = await boot(s)

  assert.deepEqual(status.modules.started, ['hello-world'], 'one bad mod must not block a good one')
  assert.equal(status.modules.rejected.length, 1)
  assert.equal(status.modules.rejected[0]!.name, 'broken')
})

test('a directory without module.json is ignored, not rejected', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  await fs.mkdir(path.join(s.modulesDir, 'notes'), { recursive: true })

  const { status } = await boot(s)

  assert.equal(status.modules.rejected.length, 0, 'a scratch dir is not a broken module')
  assert.deepEqual(status.modules.started, [])
})

test('A MODULE REPORTS ITS OWN HEALTH — core cannot compute this', async (t) => {
  // Core knows whether a module STARTED. Whether it is doing anything useful
  // needs domain knowledge core deliberately does not have, and the two answers
  // are routinely different: memory can start cleanly, hold an empty corpus, and
  // have a quarantine nobody has read — green by every measure core can take,
  // broken by every measure that matters.
  const s = await scratch()
  t.after(s.cleanup)
  await fs.mkdir(s.modulesDir, { recursive: true })
  await fs.symlink(
    path.join(REPO, 'modules', 'memory'),
    path.join(s.modulesDir, 'memory'),
    'dir',
  )

  const { status } = await boot(s)
  const memory = status.health.find((h) => h.module === 'memory')
  assert.ok(memory, 'memory reported')
  assert.match(memory!.summary, /memor/)
  assert.ok(
    memory!.warnings.some((w) => /no memories/.test(w)),
    'an empty graph is stated, not left to be inferred',
  )
})

test('module warnings reach the notes, where a human will see them', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  await fs.mkdir(s.modulesDir, { recursive: true })
  await fs.symlink(
    path.join(REPO, 'modules', 'memory'),
    path.join(s.modulesDir, 'memory'),
    'dir',
  )
  const { status } = await boot(s)
  assert.ok(status.notes.some((n) => n.startsWith('memory:')), 'prefixed and surfaced')
})

test('a module with no status() is simply absent from health, not an error', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  await installHelloWorld(s.modulesDir)
  const { status } = await boot(s)
  assert.deepEqual(status.health, [])
})

test('hostModules: a process may start only the named runs:host modules; the rest stay host-only (no second telegram poller)', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  for (const name of ['mind', 'bot']) {
    const dir = path.join(s.modulesDir, name)
    await fs.mkdir(path.join(dir, 'server'), { recursive: true })
    await fs.writeFile(path.join(dir, 'module.json'), JSON.stringify({ name, version: '1.0.0', requiresCore: '>=2.0.0 <3.0.0', runs: 'host' }))
    await fs.writeFile(path.join(dir, 'server', 'index.ts'), `import fs from 'node:fs'\nexport default { start() { fs.writeFileSync(${JSON.stringify(path.join(s.root, name))}, 'x') } }\n`)
  }
  const lc = new Lifecycle({ modulesDir: s.modulesDir, dataRoot: s.dataRoot, dbPath: s.dbPath, events: new EventBus(), storage: new Storage(s.dbPath), host: true, hostModules: ['mind'] })
  await lc.run()
  assert.deepEqual(lc.started.map((m) => m.manifest.name), ['mind'])
  assert.equal(lc.statuses.find((x) => x.name === 'bot')?.state, 'host-only')
  await assert.rejects(fs.stat(path.join(s.root, 'bot')), 'bot never started')
  await lc.stopAll()
})

test('a runs:host module\'s subscription marked outsideHost runs in other processes too, without start()', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  const dir = path.join(s.modulesDir, 'hostsub')
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'module.json'), JSON.stringify({ name: 'hostsub', version: '1.0.0', requiresCore: '>=2.0.0 <3.0.0', runs: 'host', subscribes: [{ event: 'SessionStart', handler: 'server/on-start.ts', outsideHost: true }, { event: 'Stop', handler: 'server/on-stop.ts' }] }))
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), `export default { start() { throw new Error('start must not run here') } }\n`)
  await fs.writeFile(path.join(dir, 'server', 'on-start.ts'), `import fs from 'node:fs'\nexport default (_p, ctx) => { fs.writeFileSync(${JSON.stringify(path.join(s.root, 'ran'))}, ctx.dataDir) }\n`)
  await fs.writeFile(path.join(dir, 'server', 'on-stop.ts'), `export default () => { throw new Error('not outsideHost: must not be registered') }\n`)
  const events = new EventBus()
  const lc = new Lifecycle({ modulesDir: s.modulesDir, dataRoot: s.dataRoot, dbPath: s.dbPath, events, storage: new Storage(s.dbPath) })
  await lc.run()
  assert.equal(lc.statuses.find((x) => x.name === 'hostsub')?.state, 'host-only')
  await events.publish('SessionStart', {})
  await events.publish('Stop', {})
  assert.equal(await fs.readFile(path.join(s.root, 'ran'), 'utf-8'), path.join(s.dataRoot, 'hostsub'))
})

test('a runs:host module starts only in the host process; elsewhere it is listed host-only and never runs', async (t) => {
  const s = await scratch()
  t.after(s.cleanup)
  const dir = path.join(s.modulesDir, 'hostmod')
  await fs.mkdir(dir, { recursive: true })
  const marker = path.join(s.root, 'started')
  await fs.writeFile(path.join(dir, 'module.json'), JSON.stringify({ name: 'hostmod', version: '1.0.0', requiresCore: '>=2.0.0 <3.0.0', runs: 'host', provides: ['hostmod.ping'] }))
  await fs.mkdir(path.join(dir, 'server'))
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), `import fs from 'node:fs'\nexport default { start(ctx) { fs.writeFileSync(${JSON.stringify(marker)}, 'x'); ctx.capabilities.provide('hostmod.ping', () => 'pong') } }\n`)

  const { status } = await boot(s)
  assert.deepEqual(status.modules.started, [])
  assert.deepEqual(status.modules.hostOnly.map((m) => m.name), ['hostmod'])
  assert.ok(!status.notes.some((n) => n.includes('hostmod')), 'host-only is not a problem')
  await assert.rejects(fs.stat(marker), 'start() never ran')

  const events = new EventBus()
  const host = new Lifecycle({ modulesDir: s.modulesDir, dataRoot: s.dataRoot, dbPath: s.dbPath, events, storage: new Storage(s.dbPath), host: true })
  await host.run()
  assert.deepEqual(host.started.map((m) => m.manifest.name), ['hostmod'])
  assert.equal(host.capabilities.get<() => string>('hostmod.ping')!(), 'pong')
  await host.stopAll()
})
