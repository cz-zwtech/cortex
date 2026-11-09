import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { exposedTo, exposedToDomain, readConfig } from '../server/config.js'
import { canonical, ensureDomainKey, loadDomainKey, sign, verify } from '../server/keys.js'

const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const dir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cfg-'))
  dirs.push(d)
  return d
}
const PIN = 'A'.repeat(43) + '='
const write = (d: string, c: unknown) => fs.writeFileSync(path.join(d, 'gateway.json'), JSON.stringify(c))

test('defaults: port 28417, actions off, nothing exposed, day-10 mailbox and paths', () => {
  const d = dir()
  write(d, { domain: 'home', peers: [{ domain: 'partner', pin: PIN }] })
  const c = readConfig(d)
  assert.equal(c.listen.port, 28417)
  assert.equal(c.acceptActions, false)
  assert.equal(c.mailboxDays, 10)
  assert.equal(c.pathIdleDays, 10)
  assert.deepEqual(exposedToDomain(c, 'partner'), [], 'default unticked')
  assert.deepEqual(exposedTo(c, 'partner', 'alex', 'acme-dev'), [])
})

test('exposure is per (domain, human, role); roles only', () => {
  const d = dir()
  write(d, { domain: 'home', peers: [{ domain: 'partner', pin: PIN, expose: [{ human: 'alex', role: 'acme-dev', roles: ['dev', 'pm'] }] }] })
  const c = readConfig(d)
  assert.deepEqual(exposedTo(c, 'partner', 'alex', 'acme-dev'), ['dev', 'pm'])
  assert.deepEqual(exposedTo(c, 'partner', 'ht', 'acme-dev'), [], 'another human of the same domain gets nothing')
  assert.deepEqual(exposedTo(c, 'ht', 'alex', 'acme-dev'), [], 'another domain gets nothing')
  assert.deepEqual(exposedToDomain(c, 'partner'), ['dev', 'pm'])
})

test('a config that would accept actions, a duplicate peer, or a bad pin is refused, naming the field', () => {
  const d = dir()
  write(d, { domain: 'home', acceptActions: true })
  assert.throws(() => readConfig(d), /acceptActions: this gateway never accepts actions/)
  write(d, { domain: 'home', peers: [{ domain: 'partner', pin: PIN }, { domain: 'partner', pin: PIN }] })
  assert.throws(() => readConfig(d), /peer domain partner is listed twice/)
  write(d, { domain: 'home', peers: [{ domain: 'partner', pin: 'short' }] })
  assert.throws(() => readConfig(d), /peers\.0\.pin/)
  write(d, { domain: 'home', extra: 1 })
  assert.throws(() => readConfig(d), /Unrecognized key/)
})

test('the domain key: made once (0600), never overwritten; records sign and verify, and a changed record fails', () => {
  const d = dir()
  const a = ensureDomainKey(d, 'home')
  assert.equal(a.minted, true)
  assert.equal(fs.statSync(path.join(d, 'domain.key')).mode & 0o777, 0o600)
  const b = ensureDomainKey(d, 'home')
  assert.equal(b.minted, false)
  assert.equal(b.pin, a.pin)
  const k = loadDomainKey(d)
  const rec = { t: 'xmsg', body: 'hello', from: { domain: 'home', human: 'alex', role: 'pm' } }
  const sig = sign(rec, k.privateKey)
  const pub = (await_pub(k.privateKey))
  assert.equal(verify({ ...rec, sig }, pub), true)
  assert.equal(verify({ ...rec, body: 'changed', sig }, pub), false)
  assert.equal(canonical({ b: 1, a: 2, sig: 'x' }), '{"a":2,"b":1}', 'stable order, signature left out')
})

import crypto from 'node:crypto'
const await_pub = (k: crypto.KeyObject) => crypto.createPublicKey(k)
