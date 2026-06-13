#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import { resolveGraphedRepo, blastGateKey, renderCodegraphBlast, renderFileKnowledge } from '../../bin/_codegraph-aware.js'
import type { CodegraphCache } from '../../server/codegraphCache.js'

const cache: CodegraphCache = {
  repos: [
    { repo: 'cortex', root: '/path/to/cortex' },
    { repo: 'swarm', root: '/path/to/repos/ai-coding-swarm' },
    { repo: 'codegraph', root: '/path/to/cortex/vendor/codegraph' },
  ],
  generatedAt: Date.now(),
}

const r1 = resolveGraphedRepo('/path/to/repos/ai-coding-swarm/src/blast.ts', cache)
assert.deepEqual(r1, { repo: 'swarm', root: '/path/to/repos/ai-coding-swarm', relpath: 'src/blast.ts' })

// Longest-root-prefix wins (nested repo, not the parent cortex).
const r2 = resolveGraphedRepo('/path/to/cortex/vendor/codegraph/src/x.ts', cache)
assert.equal(r2!.repo, 'codegraph')
assert.equal(r2!.relpath, 'src/x.ts')

// Parent repo still resolves for its own files.
const r3 = resolveGraphedRepo('/path/to/cortex/server/graph/db.ts', cache)
assert.equal(r3!.repo, 'cortex')
assert.equal(r3!.relpath, 'server/graph/db.ts')

// Non-graphed path → null.
assert.equal(resolveGraphedRepo('/tmp/random/file.ts', cache), null)

// Separator boundary: a sibling dir sharing a prefix STRING must NOT match.
assert.equal(resolveGraphedRepo('/path/to/repos/ai-coding-swarm-other/x.ts', cache), null)

assert.equal(blastGateKey('cortex', 'server/graph/db.ts'), 'codegraph-blast:cortex:server/graph/db.ts')

const md = renderCodegraphBlast('cortex', 'feat/fake', [
  { name: 'getConnection', file: 'server/graph/db.ts', line: 55, dependents: [
    { name: 'upsertSymbols', file: 'server/graph/symbols.ts', line: 150, edgeKind: 'CALLS' },
    { name: 'listSymbols', file: 'server/graph/symbols.ts', line: 700, edgeKind: 'CALLS' },
  ]},
])
assert.match(md, /Cortex codegraph · cortex/)
assert.match(md, /branch `feat\/fake`/)
assert.match(md, /getConnection/)
assert.match(md, /upsertSymbols/)
assert.match(md, /server\/graph\/symbols\.ts:150/)
// ── ABOUT tier-1: renderFileKnowledge (Item-2 slice 4) ──────────────────────
const fk = renderFileKnowledge('cortex', 'bin/ckn-sync.ts', [
  { name: 'cortex-restart-operational-gotchas', description: 'tsx watch does not reload on /mnt (WSL inotify)' },
  { name: 'session-bus-shipped', description: 'ckn-bus session bus on master' },
])
assert.match(fk, /knowledge for .*bin\/ckn-sync\.ts/i)
assert.match(fk, /cortex-restart-operational-gotchas/)
assert.match(fk, /tsx watch does not reload/)
assert.match(fk, /session-bus-shipped/)

// Empty hits → empty string, so the caller injects nothing (quiet by default).
assert.equal(renderFileKnowledge('cortex', 'x.ts', []), '')

// Caps at 3 bullets even if handed more.
const many = renderFileKnowledge('cortex', 'x.ts', [
  { name: 'a', description: 'da' }, { name: 'b', description: 'db' },
  { name: 'c', description: 'dc' }, { name: 'd', description: 'dd' },
])
assert.equal((many.match(/^- /gm) ?? []).length, 3, 'file-knowledge caps at 3 bullets')

// A multi-line description is collapsed to a single bullet line.
const ml = renderFileKnowledge('cortex', 'x.ts', [{ name: 'n', description: 'line one\nline two' }])
assert.equal((ml.match(/^- /gm) ?? []).length, 1, 'one bullet per hit')
assert.ok(!/line one\nline two/.test(ml), 'description newlines collapsed')

console.log('codegraph-aware OK')
