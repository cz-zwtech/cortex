#!/usr/bin/env tsx
/**
 * deriveNodeKind — the graph-kind derivation extracted from syncMemories.
 *
 * The kind survives in different SLOTS across the authored vs normalized
 * frontmatter shapes (top-level type/kind/node_type; metadata.node_type/type).
 * An enumerated graph KIND (thread) is promoted from whichever slot carries it;
 * a memory's `type` is a SUBTYPE (project/user/feedback/reference) and stays
 * kind='memory'. This is the shared, unit-tested home for that rule.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-derivekind-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { deriveNodeKind } = await import('../../server/graph/sync.js')

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// authored (un-normalized) shapes
assert.equal(deriveNodeKind({ type: 'thread' }), 'thread', 'top-level type:thread')
assert.equal(deriveNodeKind({ node_type: 'thread' }), 'thread', 'top-level node_type:thread')
assert.equal(deriveNodeKind({ type: 'memory' }), 'memory', 'top-level type:memory')
ok('authored top-level shapes')

// normalized shapes (metadata-nested; node_type FORCED to memory by the normalizer)
assert.equal(deriveNodeKind({ metadata: { node_type: 'memory', type: 'thread' } }), 'thread', 'normalized thread (type preserved, node_type forced memory)')
assert.equal(deriveNodeKind({ metadata: { node_type: 'thread' } }), 'thread', 'normalized node_type:thread (if ever preserved)')
ok('normalized shapes')

// memory SUBTYPE must NOT be promoted to a kind
assert.equal(deriveNodeKind({ metadata: { node_type: 'memory', type: 'project' } }), 'memory', 'metadata.type=project (subtype) → memory')
assert.equal(deriveNodeKind({ type: 'project' }), 'memory', 'top-level type=project (subtype) is not a thread → memory')
ok('memory subtype stays memory')

// defaults + passthrough of a non-enumerated explicit kind
assert.equal(deriveNodeKind({}), 'memory', 'empty → memory')
assert.equal(deriveNodeKind({ kind: 'session' }), 'session', 'explicit non-enumerated kind passes through')
ok('defaults + explicit-kind passthrough')

console.log(`\nOK derive-node-kind.test.ts — ${passed} assertions passed`)
