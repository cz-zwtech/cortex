/**
 * #123 — the interrupted-backfill guard (pure mayEmbedSkip).
 *
 * An unchanged entry may be skipped by the sync fast-paths ONLY if it is already
 * embedded (or embeddings are off — no vector to protect). This prevents a
 * deferred/failed embed from stranding an entry behind a content_hash match,
 * permanently unembedded + unsearchable.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// Isolate before importing sync (which transitively opens config paths).
process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-embed-guard-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { mayEmbedSkip } = await import('../../server/graph/sync.js')

const has = new Set<string>(['a'])

// embeddings OFF → always safe to skip (there are no vectors to protect)
assert.equal(mayEmbedSkip('a', new Set(), 'off'), true, 'off → skip ok even with no vector')
assert.equal(mayEmbedSkip(undefined, new Set(), 'off'), true, 'off → skip ok even with no id')

// embeddings ON → skip ONLY when a vector already exists for the id
assert.equal(mayEmbedSkip('a', has, 'local'), true, 'on + vector present → skip ok')
assert.equal(mayEmbedSkip('b', has, 'local'), false, 'on + NO vector → must NOT skip (re-embed)')
assert.equal(mayEmbedSkip(undefined, has, 'local'), false, 'on + unknown id → must NOT skip')

console.log('embed-skip-guard: OK')
process.exit(0)
