import assert from 'node:assert/strict'
import test from 'node:test'

import { presence, resolve, type Entry } from '../server/directory.js'

const e = (member: string, roles: string[], meta: Record<string, string> = {}, live = true): Entry => ({
  member,
  roles,
  live,
  lastSeen: live ? Date.now() : 0,
  meta: { machine: 'laptop', ...meta },
})

const dir = [
  e('docs-dev', ['docs'], { about: 'writes the user docs' }),
  e('website-dev', ['web'], { about: 'websites for clients' }),
  e('laptop-1', ['general']),
  e('acme-dev-1', ['acme-dev'], { cwd: '/srv/cortex/acme-main' }),
]

test('Case 1: "I\'d like docs-dev to write this guide" names the member: clear', () => {
  const r = resolve("I'd like docs-dev to write this guide", dir)
  assert.equal(r.verdict, 'clear')
  assert.equal(r.candidates[0]!.address, 'docs/docs-dev')
})

test('Case 2: "I need dev to write the user docs" infers the docs owner: clear', () => {
  const r = resolve('I need dev to write the user docs', dir)
  assert.equal(r.verdict, 'clear')
  assert.equal(r.candidates[0]!.entry.member, 'docs-dev')
})

test('Case 3: "I need this website built for northwind traders" proposes and asks', () => {
  const r = resolve('I need this website built for northwind traders', dir)
  assert.equal(r.verdict, 'ask')
  assert.equal(r.candidates[0]!.entry.member, 'website-dev', 'the likely target first')
  assert.ok(r.candidates.some((c) => c.reasons.includes('general inbox: takes unassigned work')), 'the general inbox offered too')
})

test('two members both named is never sent silently', () => {
  const r = resolve('docs-dev and website-dev should pair on this', dir)
  assert.equal(r.verdict, 'ask')
})

test('a name inside another word does not count ("ops" in "shops")', () => {
  const r = resolve('the shops need a refresh', [e('ops', ['ops'])])
  assert.notEqual(r.verdict, 'clear')
})

test('nothing matches and there is no general inbox: none', () => {
  assert.equal(resolve('tune the piano', [e('docs-dev', ['docs'])]).verdict, 'none')
})

test('presence: a service member (a module, not a session) says service, never offline', () => {
  assert.equal(presence(e('mind-node-b', ['mind'], { kind: 'service' }, false)), 'service')
  assert.equal(presence(e('mind-node-b', ['mind'], { kind: 'service' }, true)), 'service')
  assert.equal(presence(e('dev-1', ['dev'], {}, true)), 'live')
  assert.equal(presence(e('dev-1', ['dev'], {}, false)), 'offline')
})
