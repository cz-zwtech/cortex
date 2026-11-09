import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { effectiveNodeConfig, nodeConfigFile, readNodeConfig, writeNodeConfig } from '../../server/mesh/nodeConfig.js'
import { meshPort } from '../../server/mesh/control.js'
import { serve } from '../../server/mesh/daemon.js'
import { NodeTable } from '../../server/mesh/nodes.js'
import { addPeer } from '../../server/mesh/peers.js'
import { freePort, node, tmp, until } from './harness.js'

test('node.json holds the alias, port and bind, so a start without the shell profile keeps them', () => {
  const dir = tmp()
  assert.deepEqual(readNodeConfig(dir), {})
  writeNodeConfig(dir, { alias: 'node-a', port: 3021 })
  writeNodeConfig(dir, { host: '127.0.0.1' })
  assert.deepEqual(readNodeConfig(dir), { alias: 'node-a', port: 3021, host: '127.0.0.1' })
  assert.deepEqual(effectiveNodeConfig(dir, {}), { alias: 'node-a', port: 3021, host: '127.0.0.1' })
  assert.equal(meshPort(dir, {}), 3021)
})

test('the environment overrides node.json; a missing or broken file is no config', () => {
  const dir = tmp()
  writeNodeConfig(dir, { alias: 'node-a', port: 3021 })
  assert.deepEqual(effectiveNodeConfig(dir, { CKN_NODE_ALIAS: 'other', CKN_MESH_PORT: '4000', CKN_MESH_BIND: '10.0.0.1' }), { alias: 'other', port: 4000, host: '10.0.0.1' })
  fs.writeFileSync(nodeConfigFile(dir), '{ not json')
  assert.deepEqual(readNodeConfig(dir), {})
  assert.equal(meshPort(tmp(), {}), 3021)
})

test('a node bound to loopback advertises no address, since nothing elsewhere can dial it', async () => {
  const human = await node('human')
  const dir = tmp()
  addPeer(dir, human.url)
  const svc = await serve(dir, 'svc-node', await freePort(), { host: '127.0.0.1', alias: 'svc', roles: () => [{ role: 'notify', members: [{ name: 'notify-1' }] }] })
  try {
    const table = new NodeTable(human.log.db)
    await until('the human node knows the service node', () => !!table.get('svc-node'))
    assert.deepEqual(table.get('svc-node')!.addresses, [])
  } finally {
    await svc.close()
  }
})
