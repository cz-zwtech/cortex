#!/usr/bin/env tsx
/**
 * Bus housekeeping (stage 3A): ack/done confirmations are de-noised + expired so
 * the inbox stays a working surface. These are the pure decisions; the I/O
 * (pruneBusMessages) deletes by the same rule against the live DB.
 */
import assert from 'node:assert/strict'
import { isAckKind, expirableBusMessages, DEFAULT_BUS_RETENTION } from '../../server/bus/retention.js'

// ── isAckKind: only pure confirmations ──
assert.equal(isAckKind('ack'), true)
assert.equal(isAckKind('done'), true)
assert.equal(isAckKind('msg'), false, 'msg carries content — not an ack')
assert.equal(isAckKind('reply'), false, 'reply can carry content — not a pure ack')
assert.equal(isAckKind(undefined), false)

// ── expirableBusMessages: ack/done older than TTL only ──
const now = 2_000_000_000_000
const TTL = DEFAULT_BUS_RETENTION.ackTtlMs
const msgs = [
  { id: 'old-ack', kind: 'ack', createdAt: now - TTL - 1000 }, // expire
  { id: 'old-done', kind: 'done', createdAt: now - TTL - 1 }, // expire
  { id: 'fresh-ack', kind: 'ack', createdAt: now - 1000 }, // keep (too new)
  { id: 'old-msg', kind: 'msg', createdAt: now - TTL * 10 }, // keep (content)
  { id: 'old-reply', kind: 'reply', createdAt: now - TTL * 10 }, // keep (content)
]
const expired = expirableBusMessages(msgs, now)
assert.deepEqual(expired.sort(), ['old-ack', 'old-done'].sort(), 'only ack/done past TTL expire')
assert.ok(!expired.includes('fresh-ack'), 'a fresh ack is kept')
assert.ok(!expired.includes('old-msg') && !expired.includes('old-reply'), 'content kinds NEVER expire here')

// edge: exactly at the cutoff is kept (strict < cutoff)
const atEdge = expirableBusMessages([{ id: 'edge', kind: 'ack', createdAt: now - TTL }], now)
assert.deepEqual(atEdge, [], 'an ack exactly at the TTL edge is not yet expired')

console.log('retention OK')
process.exit(0)
