import assert from 'node:assert/strict'

// #139 C — ckn-embed-backfill must honor --force + --offset and implement the
// documented skip (today main() re-embeds every row unconditionally, ignores
// --force, has no offset). Logic extracted into a pure, dependency-injected core
// so skip/force/counting is provable without a DB or the embedding model.
const { parseBackfillArgs, shouldEmbedRow, runBackfill } = await import(
  '../bin/embedBackfill.core.js'
)

// ── parseBackfillArgs ────────────────────────────────────────────────────────
assert.deepEqual(parseBackfillArgs([]), { force: false, limit: null, offset: 0 })
assert.deepEqual(parseBackfillArgs(['--force']), { force: true, limit: null, offset: 0 })
assert.deepEqual(parseBackfillArgs(['--limit', '25']), { force: false, limit: 25, offset: 0 })
assert.deepEqual(parseBackfillArgs(['--offset', '50']), { force: false, limit: null, offset: 50 })
assert.deepEqual(parseBackfillArgs(['--limit', '10', '--offset', '5', '--force']), {
  force: true,
  limit: 10,
  offset: 5,
})

// ── shouldEmbedRow (the documented skip) ─────────────────────────────────────
assert.equal(shouldEmbedRow(false, false), true) // no vector -> embed
assert.equal(shouldEmbedRow(true, false), false) // has vector, no force -> skip
assert.equal(shouldEmbedRow(true, true), true) // force -> re-embed
assert.equal(shouldEmbedRow(false, true), true)

// ── runBackfill: skip already-embedded, force overrides, count correctly ─────
const rows = [
  { id: 'a', name: 'a', description: '', content: 'x' },
  { id: 'b', name: 'b', description: '', content: 'y' },
  { id: 'c', name: 'c', description: '', content: 'z' },
]
const vec = new Float32Array([1, 0, 0])

// default: only rows WITHOUT a vector are embedded; the rest are skipped
{
  const put: string[] = []
  const r = await runBackfill(rows, new Set(['a']), false, {
    embed: async () => vec,
    put: async (id: string) => { put.push(id) },
    textFor: (row: any) => row.content,
  })
  assert.deepEqual(r, { embedded: 2, skipped: 1, failed: 0 })
  assert.deepEqual(put.sort(), ['b', 'c']) // 'a' skipped, never written
}

// --force: re-embed every row regardless of existing vectors
{
  const put: string[] = []
  const r = await runBackfill(rows, new Set(['a', 'b', 'c']), true, {
    embed: async () => vec,
    put: async (id: string) => { put.push(id) },
    textFor: (row: any) => row.content,
  })
  assert.deepEqual(r, { embedded: 3, skipped: 0, failed: 0 })
  assert.deepEqual(put.sort(), ['a', 'b', 'c'])
}

// a null vector (mode off / shed) or a throw counts as failed, loop continues
{
  const r = await runBackfill(rows, new Set(), false, {
    embed: async (t: string) => (t === 'y' ? null : vec),
    put: async () => {},
    textFor: (row: any) => row.content,
  })
  assert.deepEqual(r, { embedded: 2, skipped: 0, failed: 1 })
}
{
  const r = await runBackfill(rows, new Set(), false, {
    embed: async (t: string) => { if (t === 'z') throw new Error('boom'); return vec },
    put: async () => {},
    textFor: (row: any) => row.content,
  })
  assert.deepEqual(r, { embedded: 2, skipped: 0, failed: 1 })
}

console.log('embed-backfill-core: parse + skip + force + counting OK')
process.exit(0)
