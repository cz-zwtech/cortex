#!/usr/bin/env tsx
/**
 * T1 unit test: the mesh schema migration (origin_node + mesh_seq columns,
 * idx_msg_origin_seq, mesh_cursors + mesh_seq_counter tables) applies cleanly via
 * openDb/initSchema, and meshIdentity.peerUrls parses/normalizes/dedupes/self-excludes.
 * Standalone tsx + node:assert/strict (no vitest), per test/graph/bus.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mesh-id-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
// Hermetic: point mesh config at an empty temp dir so peerUrls()/nodeId() never
// fall back to a real ~/.config/ckn/mesh.json (the feature this branch + the
// ckn-mesh CLI create on WSL would otherwise break these env-only assertions).
process.env.CKN_CONFIG_DIR = dir

const { openDb } = await import('../../server/graph/db.js')

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

async function main() {
  // ── schema: open a fresh DB, the full DDL applies on open ──────────────────
  const db = openDb(path.join(dir, 'schema-check.sqlite'))

  const busCols = (db.prepare('PRAGMA table_info(bus_messages)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  )
  assert.ok(busCols.includes('origin_node'), 'bus_messages has origin_node column')
  assert.ok(busCols.includes('mesh_seq'), 'bus_messages has mesh_seq column')

  // index present
  const idxNames = (db.prepare('PRAGMA index_list(bus_messages)').all() as Array<{ name: string }>).map(
    (i) => i.name,
  )
  assert.ok(idxNames.includes('idx_msg_origin_seq'), 'idx_msg_origin_seq exists on bus_messages')

  // new tables present
  const tableExists = (name: string): boolean =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
  assert.ok(tableExists('mesh_cursors'), 'mesh_cursors table exists')
  assert.ok(tableExists('mesh_seq_counter'), 'mesh_seq_counter table exists')

  // their columns match the spec
  const cursorCols = (db.prepare('PRAGMA table_info(mesh_cursors)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  )
  assert.deepEqual(cursorCols.sort(), ['last_seq', 'peer_node', 'updated_at'].sort(), 'mesh_cursors columns')
  const counterCols = (
    db.prepare('PRAGMA table_info(mesh_seq_counter)').all() as Array<{ name: string }>
  ).map((c) => c.name)
  assert.deepEqual(counterCols.sort(), ['node', 'seq'].sort(), 'mesh_seq_counter columns')

  db.close()

  // ── peerUrls: parse / normalize / dedupe / self-exclude ────────────────────
  const { peerUrls } = await import('../../server/bus/meshIdentity.js')

  // bare host:port normalized to http://, http:// kept, trailing slash stripped
  process.env.CKN_MESH_PEERS = 'host-a:3001, http://host-b:3002/ ,host-a:3001'
  delete process.env.CKN_MESH_SELF
  assert.deepEqual(
    peerUrls(),
    ['http://host-a:3001', 'http://host-b:3002'],
    'normalizes bare authority, strips trailing slash, dedupes',
  )

  // blanks dropped
  process.env.CKN_MESH_PEERS = ' , host-c:3003 ,,'
  assert.deepEqual(peerUrls(), ['http://host-c:3003'], 'blank entries dropped')

  // self-exclude (normalized comparison: bare self matches http:// peer)
  process.env.CKN_MESH_PEERS = 'host-a:3001,host-self:3009'
  process.env.CKN_MESH_SELF = 'host-self:3009'
  assert.deepEqual(peerUrls(), ['http://host-a:3001'], 'self-excludes CKN_MESH_SELF after normalization')

  // empty / unset → empty list
  process.env.CKN_MESH_PEERS = ''
  delete process.env.CKN_MESH_SELF
  assert.deepEqual(peerUrls(), [], 'empty CKN_MESH_PEERS → []')
  delete process.env.CKN_MESH_PEERS
  assert.deepEqual(peerUrls(), [], 'unset CKN_MESH_PEERS → []')

  console.log('mesh-identity OK')
}

main().then(
  () => {
    cleanup()
    process.exit(0)
  },
  (err) => {
    cleanup()
    console.error(err)
    process.exit(1)
  },
)
