import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { machineId } from '../core/machineId.js'
import { ensureNodeId, hookedSettings, serviceOpts } from '../core/serviceInstall.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-svc-'))

test('service options default to <host>-svc on loopback 3022, peered to the human node, role service', () => {
  assert.deepEqual(serviceOpts(['--service'], 'node-a.lan'), { alias: 'node-a-svc', port: 3022, peer: '127.0.0.1:3021', role: 'service', modules: ['comms'] })
  assert.deepEqual((serviceOpts(['--with', 'notify'], 'h') as { modules: string[] }).modules, ['comms', 'notify'])
  assert.deepEqual(serviceOpts(['--service', '--alias', 'node-a-svc', '--port', '3030', '--role', 'tracker'], 'h'), {
    alias: 'node-a-svc',
    port: 3030,
    peer: '127.0.0.1:3021',
    role: 'tracker',
    modules: ['comms'],
  })
})

test('service options refuse a bad port, alias or role', () => {
  assert.match((serviceOpts(['--port', 'x'], 'h') as { error: string }).error, /--port/)
  assert.match((serviceOpts(['--alias', 'Bad Name'], 'h') as { error: string }).error, /--alias/)
  assert.match((serviceOpts(['--role', '1x'], 'h') as { error: string }).error, /--role/)
})

test('a hostname that starts with a digit (a container id) still gives a valid default alias', () => {
  assert.equal((serviceOpts([], '2d79ebc8ce41') as { alias: string }).alias, '2d79ebc8ce41-svc')
})

test('a service node gets its own id, minted once, and it wins over the machine-id inherited from V1', () => {
  const state = tmp()
  fs.writeFileSync(path.join(state, 'machine-id'), 'node-a-901329ee\n')
  const prev = process.env.CKN_STATE_DIR
  process.env.CKN_STATE_DIR = state
  try {
    const env = { ...process.env, CKN_MACHINE: '' }
    assert.equal(machineId(env), 'node-a-901329ee')
    const first = ensureNodeId(state, 'node-a-svc')
    assert.equal(first.minted, true)
    assert.match(first.id, /^node-a-svc-[0-9a-f]{6}$/)
    assert.deepEqual(ensureNodeId(state, 'node-a-svc'), { id: first.id, minted: false })
    assert.equal(machineId(env), first.id)
  } finally {
    if (prev === undefined) delete process.env.CKN_STATE_DIR
    else process.env.CKN_STATE_DIR = prev
  }
})

test('a service install refuses a Claude config that already has Cortex hooks', () => {
  const dir = tmp()
  assert.equal(hookedSettings(dir), undefined, 'no settings file: nothing to refuse')
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'ckn-stop' }] }] } }))
  assert.equal(hookedSettings(dir), undefined, 'V1 hooks are retired separately')
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'tsx /srv/x/bin/cortex-hook.ts Stop' }] }] } }))
  assert.equal(hookedSettings(dir), path.join(dir, 'settings.json'))
})
