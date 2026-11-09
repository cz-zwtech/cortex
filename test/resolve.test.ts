import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { resolve, unmetRequires } from '../core/resolve.js'
import { parseManifest, type Manifest } from '../core/manifest.js'

/** Minimal valid manifest; tests override only what they care about. */
const mod = (name: string, over: Partial<Manifest> = {}): Manifest =>
  ({
    name,
    version: '1.0.0',
    requiresCore: '>=2.0.0',
    provides: [],
    requires: [],
    optional: [],
    subscribes: [],
    routes: [],
    commands: [],
    env: [],
    tests: [],
    ...over,
  }) as Manifest

test('zero modules resolves to an empty plan', () => {
  const plan = resolve([])
  assert.deepEqual(plan.order, [])
  assert.deepEqual(plan.blocked, [])
  assert.deepEqual(plan.cycles, [])
})

test('independent modules all start, deterministically ordered', () => {
  const plan = resolve([mod('ux'), mod('memory'), mod('comms')])
  assert.deepEqual(plan.order, ['comms', 'memory', 'ux'])
  assert.equal(plan.blocked.length, 0)
})

test('a required dependency starts before its dependent', () => {
  const plan = resolve([mod('personality', { requires: ['memory'] }), mod('memory')])
  assert.deepEqual(plan.order, ['memory', 'personality'])
})

test('an OPTIONAL dependency orders but never blocks', () => {
  // memory optionally uses comms; comms is absent. memory must still start.
  const plan = resolve([mod('memory', { optional: ['comms'] })])
  assert.deepEqual(plan.order, ['memory'])
  assert.equal(plan.blocked.length, 0, 'optional dep absent must not block')
})

test('an optional dependency that IS present still orders first', () => {
  const plan = resolve([mod('memory', { optional: ['comms'] }), mod('comms')])
  assert.deepEqual(plan.order, ['comms', 'memory'])
})

test('a missing REQUIRED dependency blocks, with a reason naming it', () => {
  const plan = resolve([mod('personality', { requires: ['memory'] })])
  assert.deepEqual(plan.order, [])
  assert.equal(plan.blocked.length, 1)
  assert.equal(plan.blocked[0]?.name, 'personality')
  assert.match(plan.blocked[0]!.reason, /requires "memory".*not installed/)
})

test('blocking is transitive: requiring a blocked mod blocks you too', () => {
  const plan = resolve([
    mod('a', { requires: ['missing'] }),
    mod('b', { requires: ['a'] }),
    mod('c', { requires: ['b'] }),
  ])
  assert.deepEqual(plan.order, [])
  assert.deepEqual(plan.blocked.map((b) => b.name).sort(), ['a', 'b', 'c'])
  assert.match(plan.blocked.find((b) => b.name === 'c')!.reason, /cannot start/)
})

test('an unaffected module still starts when another is blocked', () => {
  const plan = resolve([mod('broken', { requires: ['missing'] }), mod('fine')])
  assert.deepEqual(plan.order, ['fine'], 'one bad mod must not take the system down')
  assert.deepEqual(plan.blocked.map((b) => b.name), ['broken'])
})

test('a two-module cycle is detected and both are blocked', () => {
  const plan = resolve([mod('a', { requires: ['b'] }), mod('b', { requires: ['a'] })])
  assert.equal(plan.cycles.length, 1)
  assert.deepEqual(plan.cycles[0], ['a', 'b'])
  assert.deepEqual(plan.blocked.map((b) => b.name).sort(), ['a', 'b'])
  assert.match(plan.blocked[0]!.reason, /cycle/)
  assert.deepEqual(plan.order, [])
})

test('a longer cycle is detected and reported once, not per member', () => {
  const plan = resolve([
    mod('a', { requires: ['b'] }),
    mod('b', { requires: ['c'] }),
    mod('c', { requires: ['a'] }),
  ])
  assert.equal(plan.cycles.length, 1, 'the same cycle must not be reported three times')
  assert.deepEqual(plan.cycles[0], ['a', 'b', 'c'])
})

test('a cycle through OPTIONAL edges is still a cycle', () => {
  // Optional deps do not gate startability, but a cycle through them has no
  // valid ordering — ignoring it would make order depend on iteration luck.
  const plan = resolve([mod('a', { optional: ['b'] }), mod('b', { optional: ['a'] })])
  assert.equal(plan.cycles.length, 1)
})

test('a cycle does not prevent unrelated modules from starting', () => {
  const plan = resolve([
    mod('a', { requires: ['b'] }),
    mod('b', { requires: ['a'] }),
    mod('independent'),
  ])
  assert.deepEqual(plan.order, ['independent'])
})

test('diamond dependencies order correctly', () => {
  //   base <- left, right <- top
  const plan = resolve([
    mod('top', { requires: ['left', 'right'] }),
    mod('left', { requires: ['base'] }),
    mod('right', { requires: ['base'] }),
    mod('base'),
  ])
  assert.equal(plan.order[0], 'base')
  assert.equal(plan.order.at(-1), 'top')
  assert.ok(plan.order.indexOf('left') < plan.order.indexOf('top'))
  assert.ok(plan.order.indexOf('right') < plan.order.indexOf('top'))
})

test('order is stable across input permutations', () => {
  const a = resolve([mod('c'), mod('a'), mod('b')]).order
  const b = resolve([mod('b'), mod('c'), mod('a')]).order
  assert.deepEqual(a, b, 'a plan that varies between boots is a plan nobody can debug')
})

test('unmetRequires names each module whose hard dependencies are not in the set', () => {
  const set = [mod('a', { requires: ['b', 'c'] }), mod('b'), mod('d', { optional: ['zz'] })]
  assert.deepEqual(unmetRequires(set), [{ name: 'a', missing: ['c'] }])
  assert.deepEqual(unmetRequires([...set, mod('c')]), [])
})

test('private-mind requires memory and comms: without either it is unmet and blocked at start', () => {
  const real = (name: string) => {
    const r = parseManifest(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'modules', name, 'module.json'), 'utf-8')))
    assert.ok(r.ok, name)
    return r.manifest
  }
  const all = ['memory', 'comms', 'private-mind'].map(real)
  assert.deepEqual(real('private-mind').requires.sort(), ['comms', 'memory'])
  assert.deepEqual(unmetRequires(all), [])
  for (const gone of ['memory', 'comms']) {
    const set = all.filter((m) => m.name !== gone)
    assert.deepEqual(unmetRequires(set), [{ name: 'private-mind', missing: [gone] }])
    assert.match(resolve(set).blocked.find((b) => b.name === 'private-mind')?.reason ?? '', new RegExp(`requires "${gone}", which is not installed`))
  }
})
