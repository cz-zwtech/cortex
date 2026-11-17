import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import onSessionStart from '../../server/mesh/on-session-start.js'
import { addPeer } from '../../server/mesh/peers.js'
import { tmp } from './harness.js'

const ctx = { log: () => {} } as never

test('a session that may not start the daemon, on a node that needs one, says so in daemon.log', async () => {
  const dir = tmp()
  const before = process.env.CKN_MESH_DIR
  process.env.CKN_MESH_DIR = dir
  try {
    addPeer(dir, 'http://127.0.0.1:1')
    // Not under test as far as the hook can tell, but launched through the SDK: it starts nothing.
    const r = await onSessionStart({}, ctx, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })
    assert.equal(r, undefined)
    const log = fs.readFileSync(path.join(dir, 'daemon.log'), 'utf-8')
    assert.match(log, /session start: daemon not running and not started \(entrypoint sdk-ts\); cortex-mesh start/)
  } finally {
    if (before === undefined) delete process.env.CKN_MESH_DIR
    else process.env.CKN_MESH_DIR = before
  }
})

test('a node with no peers that does not listen needs no daemon, and nothing is written', async () => {
  const dir = tmp()
  const before = process.env.CKN_MESH_DIR
  process.env.CKN_MESH_DIR = dir
  try {
    await onSessionStart({}, ctx, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })
    assert.equal(fs.existsSync(path.join(dir, 'daemon.log')), false)
  } finally {
    if (before === undefined) delete process.env.CKN_MESH_DIR
    else process.env.CKN_MESH_DIR = before
  }
})
