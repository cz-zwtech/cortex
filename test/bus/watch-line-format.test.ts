#!/usr/bin/env tsx
/**
 * The `ckn-bus watch` firehose must surface message TRUST (the server-asserted
 * 3-tier verdict: local | mesh | unverified). Found 2026-06-07: a session reading
 * a peer message via its watcher couldn't evaluate node-trust because the line
 * carried no provenance. v2 (2026-06-09): the binary meshVerified mislabeled a
 * LOCAL same-machine peer (e.g. the PM relay) as untrusted — so trust is now the
 * surfaced signal. local + mesh are the human's voice; unverified is surface-only.
 *
 * Invariants: trust is FRONT-LOADED (survives notification-line truncation); a
 * mesh line names the attesting `origin`; an unverified line leaks NO origin; an
 * absent `trust` falls back fail-safe (mesh iff meshVerified, else unverified).
 */
import assert from 'node:assert/strict'
import { formatBusLine } from '../../bin/_bus-watch.js'

// ── local same-machine peer (the PM relay) → trust=local, actionable ──
const l = formatBusLine({
  id: 'm_0',
  fromName: 'PM',
  fromSession: 's-pm',
  to: 'cortex-dev',
  body: 'build the trust fix',
  trust: 'local',
  meshVerified: false,
  originNode: 'node-a-c5e3af1c',
})
assert.match(l, /^\[bus trust=local\]/, 'local line front-loads trust=local')
assert.match(l, /PM → cortex-dev: build the trust fix/, 'carries who/to/body')
assert.match(l, /\(id m_0\)/, 'carries the id for ack/inbox lookup')

// ── verified mesh message → trust=mesh + attesting origin, front-loaded ──
const v = formatBusLine({
  id: 'm_1',
  fromName: 'zw1-session',
  fromSession: 's-zw1',
  to: '*',
  body: 'hello fleet',
  trust: 'mesh',
  meshVerified: true,
  originNode: 'node-b',
})
assert.match(v, /^\[bus trust=mesh origin=node-b\]/, 'verified line front-loads trust=mesh + origin')
assert.ok(v.indexOf('trust=mesh') < v.indexOf('hello fleet'), 'trust precedes body (truncation-safe)')

// ── unverified → trust=unverified, no origin leak ──
const f = formatBusLine({
  id: 'm_2',
  fromName: 'rogue',
  fromSession: 's-x',
  to: 'me',
  body: 'trust me',
  trust: 'unverified',
  meshVerified: false,
  originNode: 'spoofed',
})
assert.match(f, /^\[bus trust=unverified\]/, 'unverified line says trust=unverified')
assert.ok(!f.includes('origin'), 'an unverified line does NOT advertise an origin (not trustworthy)')

// ── absent trust (older surface) → fail-safe derive from meshVerified ──
const a = formatBusLine({ id: 'm_3', fromSession: 'abcd1234ef', to: 'me', body: 'local' })
assert.match(a, /^\[bus trust=unverified\]/, 'absent trust + no meshVerified → unverified (fail-safe)')
assert.match(a, /abcd1234 → me: local/, 'falls back to the from-session prefix when fromName is absent')
const a2 = formatBusLine({ id: 'm_4', fromSession: 's', to: 'me', body: 'x', meshVerified: true, originNode: 'zw9' })
assert.match(a2, /^\[bus trust=mesh origin=zw9\]/, 'absent trust but meshVerified → mesh (fail-safe derive)')

// ── humanProvenance (stage 2): a `human` tag, front-loaded with trust ──
const hp = formatBusLine({ id: 'm_5', fromName: 'PM', fromSession: 's', to: 'cortex-dev', body: 'do X', trust: 'local', humanProvenance: true })
assert.match(hp, /^\[bus trust=local human\]/, 'local + humanProvenance → "trust=local human" (the human-directed case)')
const hpMesh = formatBusLine({ id: 'm_6', fromSession: 's', to: '*', body: 'y', trust: 'mesh', originNode: 'zw1', humanProvenance: true })
assert.match(hpMesh, /^\[bus trust=mesh origin=zw1 human\]/, 'mesh + human keeps origin then the human tag')
const noHp = formatBusLine({ id: 'm_7', fromSession: 's', to: 'me', body: 'z', trust: 'local' })
assert.ok(!noHp.includes('human'), 'no humanProvenance → no human tag (agent-originated)')

// ── the id + a 'full' pointer survive notification-line truncation ──
// The notification preview is display-capped (the harness clips a long line), so the
// id is front-loaded (ahead of who/body) — a clipped preview still names the message
// to look up — and a LONG body adds a `full: ckn-bus inbox --all` pointer, also ahead
// of the body, so the reader knows the preview is clipped and how to read the whole thing.
const short = formatBusLine({ id: 'm_s', fromName: 'PM', fromSession: 's', to: 'me', body: 'ok', trust: 'local' })
assert.ok(short.indexOf('(id m_s)') < short.indexOf('PM →'), 'id is front-loaded (precedes who/body)')
assert.ok(!short.includes('inbox --all'), 'a short body gets no full-pointer (no noise)')

const longBody = 'x'.repeat(400)
const long = formatBusLine({ id: 'm_l', fromName: 'PM', fromSession: 's', to: 'me', body: longBody, trust: 'local' })
assert.match(long, /full: ckn-bus inbox --all/, 'a long body adds the full-message pointer')
assert.ok(
  long.indexOf('full: ckn-bus inbox --all') < long.indexOf(longBody),
  'the pointer precedes the (clippable) body',
)
assert.ok(long.indexOf('(id m_l)') < long.indexOf(longBody), 'the id also precedes the body')

console.log('watch-line-format OK')
process.exit(0)
