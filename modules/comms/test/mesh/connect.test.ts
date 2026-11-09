/**
 * Connecting is a setting (2 Nov 2026): local-only by default; listen or peers turn the daemon
 * on; a node from before the setting gets it once, from what it did.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { connects, listens, migrateConnect } from '../../server/mesh/connect.js'
import { readNodeConfig, writeNodeConfig } from '../../server/mesh/nodeConfig.js'
import { addPeer, removePeer } from '../../server/mesh/peers.js'

const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-connect-'))
  dirs.push(d)
  return d
}
const status = (dir: string, links: { direction: 'in' | 'out' }[]) => fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ links }))

test('a new node is local-only; listening or a peer makes it connect, and taking both away undoes it', () => {
  const dir = tmp()
  assert.equal(connects(dir), false)
  writeNodeConfig(dir, { listen: true })
  assert.equal(connects(dir), true)
  writeNodeConfig(dir, { listen: false })
  assert.equal(connects(dir), false)
  addPeer(dir, '192.0.2.10:3021')
  assert.equal(connects(dir), true)
  removePeer(dir, '192.0.2.10:3021')
  assert.equal(connects(dir), false)
})

test('migration, once: a node others dialed into listens; one that only dialed out does not; a gateway does', () => {
  const hub = tmp()
  status(hub, [{ direction: 'in' }, { direction: 'out' }])
  assert.deepEqual(migrateConnect(hub), { wrote: true, listen: true, why: 'other nodes dial in here' })
  const desk = tmp()
  addPeer(desk, '192.0.2.10:3021')
  status(desk, [{ direction: 'out' }])
  assert.equal(migrateConnect(desk).listen, false)
  assert.equal(connects(desk), true, 'its peers still connect it')
  const gw = tmp()
  writeNodeConfig(gw, { intent: 'gateway' })
  assert.equal(migrateConnect(gw).listen, true)
  const fresh = tmp()
  assert.equal(migrateConnect(fresh).listen, false)
  assert.equal(readNodeConfig(fresh).listen, false, 'written, so it is not guessed again')
  writeNodeConfig(fresh, { listen: true })
  status(fresh, [])
  assert.deepEqual(migrateConnect(fresh), { wrote: false, listen: true, why: 'already set' }, 'an explicit setting is never overwritten')
})

test('a node from before the setting is read as it behaved, everywhere, before any migration writes it (a gateway never drops silently)', () => {
  const gw = tmp()
  writeNodeConfig(gw, { intent: 'gateway' })
  assert.equal(listens(gw), true)
  assert.equal(connects(gw), true, 'a gateway with no peers still connects')
  const hub = tmp()
  status(hub, [{ direction: 'in' }])
  addPeer(hub, '192.0.2.10:3021')
  removePeer(hub, '192.0.2.10:3021')
  assert.equal(connects(hub), true, 'removing its last peer leaves a hub others dial into listening')
  assert.equal(readNodeConfig(hub).listen, undefined, 'reading writes nothing')
  const fresh = tmp()
  assert.equal(listens(fresh), false)
})
