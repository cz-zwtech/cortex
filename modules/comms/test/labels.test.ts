/** How a message from another node is labelled for people, and the id kept beside it for replies. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { Comms } from '../server/comms.js'
import { LocalIdentity } from '../server/identity.js'
import { ADDR, MemoryTransport } from '../server/transport.js'
import type { MeshNode, MeshView } from '../server/mesh/view.js'

const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-labels-'))
  dirs.push(d)
  return d
}

const n = (node: string, alias: string, reachable: boolean): MeshNode => ({ node, alias, roles: [], reachable })

/** The label and id an item from `from` gets, on a mesh of `nodes`. */
const labelled = async (nodes: MeshNode[], from: string) => {
  const t = new MemoryTransport()
  const view: MeshView = { self: { node: 'here', alias: 'hub' }, nodes, history: [], external: [] }
  const comms = new Comms(t, new LocalIdentity(tmp()), { mesh: () => view })
  await comms.join('pm', { create: true, as: 'pm' })
  await t.post(ADDR.member('pm'), { v: 1, type: 'msg', stamp: Date.now(), from: 'dev/dev-1', to: 'pm', body: 'hi', remote: { node: from, id: `${from}.1` } } as never)
  const [item] = await comms.inbox('pm')
  return { node: item!.node, nodeId: item!.nodeId }
}

test('a node is labelled by its alias, and its id is kept for replies', async () => {
  assert.deepEqual(await labelled([n('box-1', 'box', true)], 'box-1'), { node: 'box', nodeId: 'box-1' })
})

test('an alias a rebuilt node shares with the id it left behind stays with the reachable one', async () => {
  const mesh = [n('box-old', 'box', false), n('box-new', 'box', true)]
  assert.deepEqual(await labelled(mesh, 'box-new'), { node: 'box', nodeId: 'box-new' })
  assert.deepEqual(await labelled(mesh, 'box-old'), { node: 'box-old', nodeId: 'box-old' }, 'the old one shows its id')
})

test('an alias two reachable nodes share is no one\'s: both show their ids', async () => {
  const mesh = [n('box-a', 'box', true), n('box-b', 'box', true)]
  assert.equal((await labelled(mesh, 'box-a')).node, 'box-a')
  assert.equal((await labelled(mesh, 'box-b')).node, 'box-b')
})
