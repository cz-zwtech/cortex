/**
 * Event vocabulary tests.
 *
 * Per the module's own exit criteria, deletion must be tested WITH A SUBSCRIBER
 * OBSERVING IT. Testing it with no subscriber would pass on a system that never
 * emits the event at all — the degenerate proof this project has already been
 * caught by once.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { EventBus } from '../../../core/events.js'
import { createCapabilities, type ModuleCtx } from '../../../core/ctx.js'
import { MemoryStore } from '../server/store.js'
import mod from '../server/index.js'
import { MEMORY_UPSERTED, MEMORY_DELETED } from '../server/types.js'

const SCHEMA = path.join(import.meta.dirname, '..', 'schema.sql')

const boot = async () => {
  const db = new Database(':memory:')
  MemoryStore.applySchema(db, SCHEMA)
  const events = new EventBus()
  const ctx: ModuleCtx = {
    name: 'memory',
    dir: path.join(import.meta.dirname, '..'),
    db,
    dataDir: '/tmp/cortex-test-data',
    events,
    capabilities: createCapabilities(),
    core: { version: '2.0.0', contract: '2.0.0' },
    log: () => {},
  }
  await mod.start?.(ctx)
  return { ctx, events }
}

const sample = {
  id: 'm1',
  source: '/memory/m1.md',
  name: 'A memory',
  description: 'desc',
  content: 'body',
  shape: 'decision' as const,
  authorship: 'authored' as const,
  scope: 'user',
  pinned: false,
  protected: false,
  machine: 'node-a',
  authoredAt: 1000,
  outcome: '',
  outcomeText: '',
}

test('recording a memory emits memory.upserted TO A SUBSCRIBER', async () => {
  const { ctx, events } = await boot()
  const seen: unknown[] = []
  events.subscribe(MEMORY_UPSERTED, 'observer', (p) => void seen.push(p))

  const record = ctx.capabilities.get<(i: typeof sample) => Promise<unknown>>('memory.record')!
  await record(sample)

  assert.equal(seen.length, 1, 'a subscriber must actually receive it')
  assert.equal((seen[0] as { id: string }).id, 'm1')
})

test('re-recording UNCHANGED content emits nothing', async () => {
  const { ctx, events } = await boot()
  let count = 0
  events.subscribe(MEMORY_UPSERTED, 'observer', () => void count++)

  const record = ctx.capabilities.get<(i: typeof sample) => Promise<unknown>>('memory.record')!
  await record(sample)
  await record(sample)

  assert.equal(count, 1, 'an unchanged re-ingest must not spam subscribers')
})

test('DELETION emits memory.deleted, observed by a subscriber', async () => {
  // The gate: V1 never wired tombstone origination, so deleting a memory on one
  // machine silently returned it from another. This test is the reason that
  // cannot happen here — and it asserts on the SUBSCRIBER, not on the emitter.
  const { ctx, events } = await boot()
  const seen: { id: string; source: string }[] = []
  events.subscribe(MEMORY_DELETED, 'observer', (p) => void seen.push(p as never))

  const record = ctx.capabilities.get<(i: typeof sample) => Promise<unknown>>('memory.record')!
  const del = ctx.capabilities.get<(id: string) => Promise<boolean>>('memory.delete')!

  await record(sample)
  assert.equal(await del('m1'), true)

  assert.equal(seen.length, 1, 'deletion MUST reach a subscriber')
  assert.equal(seen[0]?.id, 'm1')
  assert.equal(seen[0]?.source, '/memory/m1.md', 'carries the source so a peer can act on it')
})

test('deleting a memory that does not exist emits nothing', async () => {
  const { ctx, events } = await boot()
  let count = 0
  events.subscribe(MEMORY_DELETED, 'observer', () => void count++)

  const del = ctx.capabilities.get<(id: string) => Promise<boolean>>('memory.delete')!
  assert.equal(await del('never-existed'), false)
  assert.equal(count, 0)
})

test('the module provides exactly the capabilities its manifest promises', async () => {
  // This READS THE MANIFEST. An earlier revision compared against a hardcoded
  // list while claiming in its own name to check the manifest — so it could only
  // ever catch a change to the code, never a DIVERGENCE between code and
  // manifest, which is the entire thing it exists to catch. It also had to be
  // hand-edited whenever a capability was added, which is precisely how a
  // literal drifts away from the thing it is supposed to mirror.
  const { ctx } = await boot()
  const manifest = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '..', 'module.json'), 'utf-8'),
  ) as { provides: string[] }

  assert.deepEqual(ctx.capabilities.list(), [...manifest.provides].sort())
})

test('memory subscribes to NO lifecycle events yet — parked by design', async () => {
  const { events } = await boot()
  assert.deepEqual(
    events.topics(),
    [],
    'hook subscribers wait for the dispatcher to survive a real harness UAT',
  )
})
