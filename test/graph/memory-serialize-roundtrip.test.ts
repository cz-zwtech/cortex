#!/usr/bin/env tsx
/**
 * memoryAdapter lossy-round-trip fix + the litmus normalizer-round-trip guard.
 *
 * The editor models only name/description/type/body, but a memory file's
 * frontmatter carries much more — id, the normalizer's nested `metadata:` block
 * (node_type/status/next_step/links for THREADS), machine lineage, pinned. The
 * old serializer wrote only the modeled fields, so a UI edit DESTROYED the rest,
 * flattening a thread into a dead memory. serializeMemory preserves the original
 * frontmatter and overrides only the modeled fields.
 *
 * This test round-trips the EXACT normalizer-output thread shape through an edit
 * and asserts: the metadata block + id + machine survive, name/description are
 * overridden, no competing top-level `type` is injected, and (the litmus tie-in)
 * deriveNodeKind STILL resolves the round-tripped frontmatter to 'thread'.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-memserialize-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { serializeMemory } = await import('../../src/adapters/memorySerialize.ts')
const { parse } = await import('../../src/adapters/frontmatter.ts')
const { deriveNodeKind } = await import('../../server/graph/sync.js')

// Byte-for-byte the normalizer-output thread shape (cf. thread-cortex-memory-build.md).
const NORMALIZED_THREAD = [
  '---',
  'name: cortex-memory-build',
  'description: the resume-surface build thread',
  'metadata:',
  '  node_type: memory',
  '  id: thread:cortex-memory-build',
  '  type: thread',
  '  status: in-progress',
  '  next_step: Run the cross-session litmus',
  '  links:',
  '    - cortex-memory-one-mind-use-case',
  '  repo: claude-config-dashboard',
  '  machine: node-a-c5e3af1c',
  '---',
  'Narrative body.',
  '',
].join('\n')

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. editing a thread in the UI preserves its whole metadata block
{
  const out = serializeMemory(
    { name: 'cortex-memory-build', description: 'EDITED in the UI', type: 'project' },
    'New body text.',
    NORMALIZED_THREAD,
  )
  const { data, body } = parse(out)
  const meta = (data as any).metadata
  assert.ok(meta && typeof meta === 'object', 'metadata block survives the round-trip')
  assert.equal(meta.type, 'thread', 'metadata.type preserved')
  assert.equal(meta.node_type, 'memory', 'metadata.node_type preserved')
  assert.equal(meta.status, 'in-progress', 'status preserved')
  assert.equal(meta.next_step, 'Run the cross-session litmus', 'next_step preserved (NOT lost)')
  assert.deepEqual(meta.links, ['cortex-memory-one-mind-use-case'], 'links preserved')
  assert.equal(meta.id, 'thread:cortex-memory-build', 'nested id preserved')
  assert.equal(meta.machine, 'node-a-c5e3af1c', 'machine lineage preserved')
  assert.equal((data as any).description, 'EDITED in the UI', 'description overridden by the edit')
  assert.equal(body, 'New body text.', 'body overridden by the edit')
  assert.ok(!('type' in (data as any)), 'no competing top-level type injected (kind stays under metadata)')
  ok('thread round-trips through a UI edit with its metadata intact')
}

// ── 2. the litmus tie-in: the round-tripped frontmatter still derives to 'thread'
{
  const out = serializeMemory(
    { name: 'x', description: 'y', type: 'project' },
    'b',
    NORMALIZED_THREAD,
  )
  assert.equal(deriveNodeKind(parse(out).data as any), 'thread', 'round-tripped thread is still kind=thread')
  ok('deriveNodeKind still resolves the edited thread to thread (no silent demotion)')
}

// ── 3. a plain memory WITH a top-level type → type is honored on edit
{
  const PLAIN = '---\nname: foo\ndescription: d\ntype: memory\nid: mem:foo\n---\nbody\n'
  const out = serializeMemory({ name: 'foo', description: 'd2', type: 'feedback' }, 'b2', PLAIN)
  const { data } = parse(out)
  assert.equal((data as any).type, 'feedback', 'top-level type honored when the original had one')
  assert.equal((data as any).id, 'mem:foo', 'id still preserved')
  ok('plain memory: top-level type honored + other fields preserved')
}

// ── 4. a brand-new memory (no original) → modeled fields written
{
  const out = serializeMemory({ name: 'n', description: 'd', type: 'project' }, 'body', undefined)
  const { data } = parse(out)
  assert.equal((data as any).name, 'n', 'name written')
  assert.equal((data as any).type, 'project', 'type written for a new file')
  ok('new memory writes the modeled fields')
}

console.log(`\nOK memory-serialize-roundtrip.test.ts — ${passed} assertions passed`)
