/**
 * Budget and fault isolation — the coordination model's actual claim.
 *
 * This is the in-process half of UAT stage 4. It cannot substitute for the real
 * harness run (a real timeout is enforced by the harness, not by us), but it
 * does prove the mechanism exists and behaves, which is more than the design
 * document could claim before.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventBus } from '../core/events.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Block the event loop, the way a synchronous native binding does.
 *
 * This distinction is the whole point of the tests below. An earlier revision
 * of this file used only `sleep`, which yields and is therefore abortable — so
 * the suite passed while asserting a guarantee the system does not have. That
 * is the degenerate proof this project keeps catching: the fixture was chosen
 * such that the claim could not fail.
 */
const blockFor = (ms: number) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* deliberately spin — no await, no yield */
  }
}

test('MEASURED LIMIT: a SYNCHRONOUS subscriber cannot be preempted, only observed', async () => {
  // The sharpest finding of the independent review, verified rather than
  // accepted: in-process JS has no preemption. better-sqlite3 is a synchronous
  // native binding, so this is exactly what a memory module does.
  const bus = new EventBus()
  const ran: string[] = []

  bus.subscribe('E', 'sync-hog', () => {
    blockFor(300)
    ran.push('sync-hog')
  }, 10)
  bus.subscribe('E', 'after', () => void ran.push('after'), 20)

  const started = Date.now()
  const result = await bus.publish('E', null, { perSubscriberMs: 50 })
  const elapsed = Date.now() - started

  // The budget did NOT stop it. Asserting the real behaviour rather than the
  // one we wish we had — a test that pretended otherwise would be worse than
  // no test.
  assert.ok(elapsed >= 300, `expected the blocking subscriber to run to completion, took ${elapsed}ms`)
  assert.deepEqual(ran, ['sync-hog', 'after'], 'it completed despite a 50ms budget')
  assert.equal(result.failures.length, 0, 'and it is not a failure — it succeeded, late')

  // But it MUST be visible. Silent overruns are how one module eats an event's
  // whole allowance while everything looks green.
  assert.equal(result.overruns.length, 1, 'an un-preemptable overrun must still be REPORTED')
  assert.equal(result.overruns[0]?.module, 'sync-hog')
  assert.ok(result.overruns[0]!.elapsedMs >= 300)
  assert.equal(result.overruns[0]?.budgetMs, 50)
})

test('an ASYNC slow subscriber IS abandoned at the deadline', async () => {
  const bus = new EventBus()
  const ran: string[] = []

  bus.subscribe('E', 'slow', async () => {
    await sleep(1000)
    ran.push('slow')
  }, 10)
  bus.subscribe('E', 'fast', () => {
    ran.push('fast')
  }, 20)

  const result = await bus.publish('E', null, { perSubscriberMs: 50 })

  assert.deepEqual(ran, ['fast'], 'the fast subscriber must still have run')
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]?.module, 'slow')
  assert.equal(result.failures[0]?.timedOut, true)
})

test('a throwing subscriber is isolated and named', async () => {
  const bus = new EventBus()
  const ran: string[] = []

  bus.subscribe('E', 'boom', () => {
    throw new Error('exploded')
  }, 10)
  bus.subscribe('E', 'ok', () => {
    ran.push('ok')
  }, 20)

  const result = await bus.publish('E')

  assert.deepEqual(ran, ['ok'])
  assert.equal(result.delivered, 1)
  assert.equal(result.failures[0]?.module, 'boom')
  assert.match(result.failures[0]!.error.message, /exploded/)
  assert.notEqual(result.failures[0]?.timedOut, true, 'a throw is not a timeout')
})

test('subscribers run in declared order, not registration order', async () => {
  const bus = new EventBus()
  const ran: string[] = []

  bus.subscribe('E', 'third', () => void ran.push('third'), 300)
  bus.subscribe('E', 'first', () => void ran.push('first'), 100)
  bus.subscribe('E', 'second', () => void ran.push('second'), 200)

  await bus.publish('E')
  assert.deepEqual(ran, ['first', 'second', 'third'])
})

test('ties break by registration order, so sequence is stable', async () => {
  const bus = new EventBus()
  const ran: string[] = []
  bus.subscribe('E', 'a', () => void ran.push('a'), 100)
  bus.subscribe('E', 'b', () => void ran.push('b'), 100)
  bus.subscribe('E', 'c', () => void ran.push('c'), 100)
  await bus.publish('E')
  assert.deepEqual(ran, ['a', 'b', 'c'])
})

test('exhausting the total budget SKIPS the rest and reports them', async () => {
  const bus = new EventBus()
  const ran: string[] = []

  bus.subscribe('E', 'hog', async () => {
    await sleep(60)
    ran.push('hog')
  }, 10)
  bus.subscribe('E', 'starved', () => void ran.push('starved'), 20)

  const result = await bus.publish('E', null, { perSubscriberMs: 500, totalMs: 40 })

  assert.ok(!ran.includes('starved'), 'the second subscriber must not have run')
  const skipped = result.failures.find((f) => f.module === 'starved')
  assert.ok(skipped, 'a skipped subscriber must be REPORTED, never silently dropped')
  assert.match(skipped!.error.message, /budget/)
})

test('no budget means no timeout — a slow subscriber completes', async () => {
  const bus = new EventBus()
  let done = false
  bus.subscribe('E', 'slow', async () => {
    await sleep(30)
    done = true
  })
  const result = await bus.publish('E')
  assert.equal(done, true)
  assert.equal(result.failures.length, 0)
})

test('stopping a module removes its subscriptions', async () => {
  const bus = new EventBus()
  let calls = 0
  bus.subscribe('E', 'mod', () => void calls++)
  await bus.publish('E')
  assert.equal(calls, 1)

  bus.unsubscribeModule('mod')
  await bus.publish('E')
  assert.equal(calls, 1, 'a stopped module must not keep receiving events')
  assert.deepEqual(bus.topics(), [])
})
