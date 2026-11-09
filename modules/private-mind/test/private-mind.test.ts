import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import type { ModuleCtx } from '../../../core/ctx.js'
import { registerDeclaredKinds, sendableTo } from '../../comms/server/mesh/log.js'
import { keptHome, shapeRule } from '../server/classify.js'
import { commit, commitId, sharedPoint } from '../server/commits.js'
import { loadConfig, MindConfigSchema } from '../server/config.js'
import mod from '../server/index.js'
import { gossip, loadState, record, saveState } from '../server/state.js'

const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mind-'))
  dirs.push(d)
  return d
}

test('mind.json: absent means not configured; present, it is inert unless enabled; anything unknown is refused', () => {
  const dir = tmp()
  assert.equal(loadConfig(dir), undefined)
  fs.writeFileSync(path.join(dir, 'mind.json'), JSON.stringify({ central: 'server-a' }))
  const c = loadConfig(dir)!
  assert.equal(c.enabled, false, 'off by default')
  assert.deepEqual(c.working.shapes, ['workflow', 'thread'])
  assert.deepEqual(c.localRoles, [])
  fs.writeFileSync(path.join(dir, 'mind.json'), JSON.stringify({ central: 'server-a', enable: true }))
  assert.throws(() => loadConfig(dir), /mind.json: \(top\): Unrecognized key/)
  fs.writeFileSync(path.join(dir, 'mind.json'), '{ not json')
  assert.throws(() => loadConfig(dir), /mind.json:/)
})

test('commit ids: the same vectors give the same id in any key order; a chain keeps five, newest first', () => {
  const base = { vv: { a: 3, b: 1 }, bvv: { a: 9 }, at: 100, node: 'a' }
  assert.equal(commitId(base), commitId({ ...base, vv: { b: 1, a: 3 } }))
  assert.notEqual(commitId(base), commitId({ ...base, parent: 'x' }))
  let chain = commit([], base)
  for (let i = 1; i <= 6; i++) chain = commit(chain, { ...base, at: 100 + i, vv: { a: 3 + i } })
  assert.equal(chain.length, 5)
  assert.equal(chain[0]!.parent, chain[1]!.id, 'each names its parent')
  assert.equal(sharedPoint(chain, ['zzz', chain[2]!.id, chain[3]!.id])?.id, chain[2]!.id, 'the newest commit both hold')
  assert.equal(sharedPoint(chain, ['zzz']), undefined, 'none: fall back to a vector diff')
})

test('state: central extends the canonical lineage; another node records the central commit it is built on', () => {
  const dir = tmp()
  const central = record(loadState(dir), { vv: { a: 1 }, bvv: {}, at: 1, node: 'a' }, true)
  assert.equal(central.base, central.commits[0]!.id)
  assert.deepEqual(central.central, [central.commits[0]!.id])
  const other = record({ commits: [], central: central.central, base: central.base, degraded: false }, { vv: { a: 1, b: 2 }, bvv: {}, at: 2, node: 'b' }, false)
  assert.equal(other.commits[0]!.base, central.base)
  saveState(dir, other)
  assert.deepEqual(loadState(dir), other)
  const g = gossip(other, { node: 'b', vv: { a: 1, b: 2 }, bvv: {}, roles: [], at: 3 })
  assert.deepEqual(Object.keys(g).sort(), ['at', 'base', 'bvv', 'commits', 'degraded', 'node', 'role', 'vv'])
})

test('what stays home: working shapes when ingested, and anything a local role wrote', () => {
  const cfg = MindConfigSchema.parse({ localRoles: ['contoso'] })
  assert.equal(shapeRule(cfg)({ shape: 'workflow' }), 'working')
  assert.equal(shapeRule(cfg)({ shape: 'decision' }), undefined, 'not decided here: the session rule follows')
  assert.equal(keptHome(cfg, ['contoso', 'pm']), true)
  assert.equal(keptHome(cfg, ['pm']), false)
})

test('mind-state is declared home-only: it never reaches a gateway', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'module.json'), 'utf-8'))
  assert.deepEqual(registerDeclaredKinds([{ module: 'private-mind', kinds: manifest.meshKinds }]), [])
  assert.equal(sendableTo('mind-state', 'gateway'), false)
  assert.equal(sendableTo('mind-state', 'node'), true)
})

const ctxFor = (dataDir: string, extra: Record<string, unknown> = {}) => {
  const caps = new Map<string, unknown>(Object.entries(extra))
  const published: { kind: string; address: string; payload: string }[] = []
  caps.set('comms.logPublish', (kind: string, address: string, payload: string) => published.push({ kind, address, payload }))
  const logs: string[] = []
  const ctx = {
    name: 'private-mind',
    dir: '',
    dataDir,
    events: { publish: async () => {} },
    capabilities: { get: (id: string) => caps.get(id), has: (id: string) => caps.has(id), provide: (id: string, impl: unknown) => caps.set(id, impl), revoke: () => {}, list: () => [...caps.keys()] },
    core: { version: '2', contract: '1' },
    log: (m: string) => logs.push(m),
  } as unknown as ModuleCtx
  return { ctx, caps, published, logs }
}

test('the module: nothing without mind.json, no gossip until enabled, and a refusal on a gateway node', async () => {
  const mesh = tmp()
  process.env.CKN_MESH_DIR = mesh
  try {
    const dir = tmp()
    let r = ctxFor(dir)
    await mod.start!(r.ctx)
    assert.match(mod.status!(r.ctx).summary, /not configured/)

    fs.writeFileSync(path.join(dir, 'mind.json'), JSON.stringify({ central: 'server-a' }))
    let registered = 0
    r = ctxFor(dir, { 'memory.classifier': () => (registered++, () => {}) })
    await mod.start!(r.ctx)
    assert.match(mod.status!(r.ctx).summary, /NOT enabled/)
    assert.equal(r.published.length, 0, 'configured but not enabled: silent')
    assert.equal(registered, 1, 'the shape rule is registered with memory')
    mod.stop?.(r.ctx)

    fs.writeFileSync(path.join(dir, 'mind.json'), JSON.stringify({ central: 'server-a', enabled: true }))
    r = ctxFor(dir, { 'memory.versionVector': () => ({ x: 4 }), 'memory.blockVector': () => ({ x: 9 }) })
    await mod.start!(r.ctx)
    assert.equal(r.published.length, 0, 'enabled without memory, comms and mesh: it says so and does nothing')
    assert.match(mod.status!(r.ctx).summary, /cannot sync without memory.journalStream/)
    mod.stop?.(r.ctx)

    // comms says what this node is (from its node config)
    r = ctxFor(dir, { 'comms.intent': () => 'gateway' })
    await mod.start!(r.ctx)
    assert.equal(r.published.length, 0)
    assert.equal(r.caps.has('private-mind.status'), false)
    assert.match(mod.status!(r.ctx).summary, /never runs on a gateway node/)
    assert.equal(mod.status!(r.ctx).warnings, undefined, 'installed everywhere, so not running on a gateway is no fault')
  } finally {
    delete process.env.CKN_MESH_DIR
  }
})

test('a private place matches every way its dir is written as a scope: slashes, dots, dashes, any case', async () => {
  const { placeKept } = await import('../server/classify.js')
  const cfg = MindConfigSchema.parse({ localDirs: ['/mnt/data/Projects/Northwind.Api.Orders', '/mnt/data/Projects/northwind/'] })
  for (const scope of ['-mnt-data-Projects-Northwind-Api-Orders', '-mnt-data-Projects-Northwind.Api.Orders', '-mnt-data-projects-northwind-api-orders-sub', '-mnt-data-Projects-northwind', '-mnt-data-Projects-Northwind-api'])
    assert.equal(placeKept(cfg, { scope }), true, scope)
  for (const scope of ['-mnt-data-Projects', '-mnt-data-Projects-other', 'user', '-home-alex']) assert.equal(placeKept(cfg, { scope }), false, scope)
  assert.equal(placeKept(cfg, { cwd: '/mnt/data/Projects/Northwind.Api.Orders/src' }), true)
  assert.equal(placeKept(cfg, { cwd: '/mnt/data/Projects/elsewhere' }), false)
})
