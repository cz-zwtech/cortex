#!/usr/bin/env tsx
/**
 * Silent-layer hook trigger (#111). The UserPromptSubmit hook must DELIVER the per-turn fold
 * request to the server (Q2: the server enqueues + fast-acks; the hook awaits the ack, not a
 * spawn-and-exit that could drop it) and SWALLOW a down/busy server so the prompt is never
 * blocked or broken — and it must hit the LOCAL fold path (/api/graph/sync/turn), NEVER the
 * remote mind-sync path.
 */
import assert from 'node:assert/strict'

const { triggerTurnSyncRequest, TURN_SYNC_PATH } = await import('../bin/_turn-sync-trigger.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// delivers + targets the LOCAL turn-sync path, never mind-sync
{
  const urls: string[] = []
  const fakeFetch = async (url: string) => {
    urls.push(url)
    return { ok: true, status: 202 }
  }
  const r = await triggerTurnSyncRequest('http://localhost:3001', fakeFetch)
  assert.equal(r, 'delivered', 'a 2xx ack → delivered (server received it)')
  assert.equal(urls.length, 1, 'exactly one request')
  assert.ok(urls[0]!.endsWith(TURN_SYNC_PATH), 'targets the turn-sync path')
  assert.ok(urls[0]!.includes('/api/graph/sync/turn'), 'targets /api/graph/sync/turn (local fold)')
  assert.ok(!urls[0]!.includes('/api/mind/'), 'NEVER the remote mind-sync path')
  ok('delivers to /api/graph/sync/turn (local), never /api/mind/*')
}

// swallows a down/busy server — never throws, returns failed
{
  const boom = async () => {
    throw new Error('ECONNREFUSED')
  }
  const r = await triggerTurnSyncRequest('http://localhost:3001', boom)
  assert.equal(r, 'failed', 'server down → failed, no throw')
  ok('swallows a down/busy server (no throw, returns failed)')
}

// non-ok response → failed (not delivered), still no throw
{
  const fiveHundred = async () => ({ ok: false, status: 500 })
  const r = await triggerTurnSyncRequest('http://localhost:3001', fiveHundred)
  assert.equal(r, 'failed', 'non-2xx → failed')
  ok('non-ok response → failed, no throw')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
