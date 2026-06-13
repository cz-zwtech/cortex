#!/usr/bin/env tsx
/** mesh config file fallback: env wins, file fills the gap, token never read here. */
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-meshcfg-'))
process.env.CKN_CONFIG_DIR = tmp  // meshConfig reads <CKN_CONFIG_DIR or ~/.config/ckn>/mesh.json
fs.writeFileSync(path.join(tmp, 'mesh.json'),
  JSON.stringify({ peers: ['192.0.2.12:3001'], nodeId: 'wsl-dev', self: '' }))

// clear env so the file is the source
delete process.env.CKN_MESH_PEERS; delete process.env.CKN_NODE_ID; delete process.env.CKN_MESH_SELF

const { readMeshConfig } = await import('../../server/bus/meshConfig.js')
const { peerUrls, nodeId } = await import('../../server/bus/meshIdentity.js')

let passed = 0; const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const cfg = readMeshConfig()
assert.deepEqual(cfg.peers, ['192.0.2.12:3001'], 'reads peers from file')
assert.equal(cfg.nodeId, 'wsl-dev', 'reads nodeId from file')
ok('readMeshConfig parses mesh.json')

// peerUrls() normalizes file peers when env is unset
assert.deepEqual(peerUrls(), ['http://192.0.2.12:3001'], 'peerUrls falls back to file + normalizes')
assert.equal(nodeId(), 'wsl-dev', 'nodeId falls back to file')
ok('meshIdentity falls back to file when env unset')

// env takes precedence over file
process.env.CKN_MESH_PEERS = 'http://1.2.3.4:9'
process.env.CKN_NODE_ID = 'env-node'
assert.deepEqual(peerUrls(), ['http://1.2.3.4:9'], 'env peers win over file')
assert.equal(nodeId(), 'env-node', 'env nodeId wins over file')
ok('env precedence over file')

// CLI: set then show round-trips through the file
delete process.env.CKN_MESH_PEERS; delete process.env.CKN_NODE_ID
const { runMeshCli } = await import('../../bin/ckn-mesh.js')
runMeshCli(['set', '--peer', 'http://192.0.2.12:3001', '--node-id', 'wsl-dev'])
const after = readMeshConfig()
assert.deepEqual(after.peers, ['http://192.0.2.12:3001'], 'CLI set writes peer')
assert.equal(after.nodeId, 'wsl-dev', 'CLI set writes nodeId')
ok('ckn-mesh set writes the config file')

console.log(`\n${passed} assertions passed.`)
fs.rmSync(tmp, { recursive: true, force: true })
