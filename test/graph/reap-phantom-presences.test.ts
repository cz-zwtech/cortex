#!/usr/bin/env tsx
/**
 * phantomReapDecision — Part 3 of the session-identity fix. Retire same-machine
 * presence rows that are bootstrap PHANTOMS: no `<id>.jsonl` transcript on this
 * host AND past the fresh-session grace window. Discriminator is SAME-MACHINE
 * TRANSCRIPT EXISTENCE ONLY (blank cwd/name is unreliable — a post-rebind phantom
 * carried name+cwd+machine). Never reaps: a transcript-backed row, a within-grace
 * fresh session, a mesh-remote row (its transcript is on another machine), or an
 * already signed_off row. Retire = status→signed_off; bus_messages are KEPT.
 */
import assert from 'node:assert/strict'
import { phantomReapDecision } from '../../server/bus/reapPhantomPresences.ts'

const HOST = 'node-a-c5e3af1c'
const REMOTE = 'node-b-901329ee'
const NOW = 1_700_000_000_000
const MIN = 60_000
const GRACE = 5 * MIN

const row = (o: Partial<{ sessionId: string; machine: string; rawStatus: string; startedAt: number }>) => ({
  sessionId: o.sessionId ?? 'x',
  machine: o.machine ?? HOST,
  rawStatus: o.rawStatus ?? 'live',
  startedAt: o.startedAt ?? NOW - 30 * MIN,
})

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. a same-machine, transcript-less, past-grace live row IS a phantom → retire
{
  const out = phantomReapDecision({
    rows: [row({ sessionId: 'phantom', startedAt: NOW - 30 * MIN })],
    transcriptIds: new Set<string>(), // no transcript on this host
    thisMachine: HOST,
    now: NOW,
    graceMs: GRACE,
  })
  assert.deepEqual(out, ['phantom'], 'transcript-less same-machine past-grace row is reaped')
  ok('phantom (no transcript, past grace) is retired')
}

// ── 2. a transcript-backed row is NEVER reaped (even if old)
{
  const out = phantomReapDecision({
    rows: [row({ sessionId: 'real', startedAt: NOW - 99 * MIN })],
    transcriptIds: new Set(['real']),
    thisMachine: HOST,
    now: NOW,
    graceMs: GRACE,
  })
  assert.deepEqual(out, [], 'a row with a live transcript is spared')
  ok('transcript-backed row is spared')
}

// ── 3. grace window: a fresh transcript-less row (no transcript flushed yet) is spared
{
  const out = phantomReapDecision({
    rows: [row({ sessionId: 'fresh', startedAt: NOW - 1 * MIN })], // within grace
    transcriptIds: new Set<string>(),
    thisMachine: HOST,
    now: NOW,
    graceMs: GRACE,
  })
  assert.deepEqual(out, [], 'a within-grace fresh session is spared (no transcript yet at SessionStart)')
  ok('grace window spares a fresh session')
}

// ── 4. mesh-remote row: its transcript lives on another machine → NEVER reap on absence
{
  const out = phantomReapDecision({
    rows: [row({ sessionId: 'remote', machine: REMOTE, startedAt: NOW - 99 * MIN })],
    transcriptIds: new Set<string>(), // we only see THIS host's transcripts
    thisMachine: HOST,
    now: NOW,
    graceMs: GRACE,
  })
  assert.deepEqual(out, [], 'a mesh-remote row is never reaped on local transcript-absence')
  ok('mesh-remote rows are scoped out (same-machine only)')
}

// ── 5. already signed_off → no-op (don't re-retire / churn)
{
  const out = phantomReapDecision({
    rows: [row({ sessionId: 'dead', rawStatus: 'signed_off', startedAt: NOW - 99 * MIN })],
    transcriptIds: new Set<string>(),
    thisMachine: HOST,
    now: NOW,
    graceMs: GRACE,
  })
  assert.deepEqual(out, [], 'an already signed_off row is left alone')
  ok('signed_off row is a no-op')
}

// ── 6. mixed batch returns only the genuine phantoms
{
  const out = phantomReapDecision({
    rows: [
      row({ sessionId: 'real', startedAt: NOW - 10 * MIN }),
      row({ sessionId: 'phantom1', startedAt: NOW - 10 * MIN }),
      row({ sessionId: 'fresh', startedAt: NOW - 30_000 }),
      row({ sessionId: 'remote', machine: REMOTE, startedAt: NOW - 10 * MIN }),
      row({ sessionId: 'phantom2', rawStatus: 'idle', startedAt: NOW - 10 * MIN }),
    ],
    transcriptIds: new Set(['real']),
    thisMachine: HOST,
    now: NOW,
    graceMs: GRACE,
  })
  assert.deepEqual(out.sort(), ['phantom1', 'phantom2'], 'only same-machine transcript-less past-grace rows')
  ok('mixed batch isolates the genuine phantoms')
}

console.log(`\nOK reap-phantom-presences.test.ts — ${passed} assertions passed`)
