import assert from 'node:assert/strict'

// #146 — the commit-2 stat fast-path skipped reading a file whose (mtime,size)
// were unchanged, so a same-size body edit with a preserved mtime was never
// re-hashed and its change was silently dropped. The fix adds ctime to the
// read-gate: a content write always bumps ctime (and ctime cannot be set via
// utimes), so a preserved-mtime edit is still read + caught, while a truly
// untouched file keeps a stable ctime and still skips.
const { statUnchanged } = await import('../../server/graph/syncManifest.js')

// manifest entry: { mtime, size, ctime }
const mk = (mtime: number, size: number, ctime: number | null) =>
  new Map([['f', { mtime, size, ctime }]])

// all three identical (ctime stored) -> unchanged -> SKIP
assert.equal(statUnchanged('f', 100, 10, 50, mk(100, 10, 50)), true)

// same mtime + size but ctime DIFFERS (the preserved-mtime content edit) -> READ
assert.equal(statUnchanged('f', 100, 10, 999, mk(100, 10, 50)), false)

// size or mtime differ -> READ (unchanged from before)
assert.equal(statUnchanged('f', 100, 99, 50, mk(100, 10, 50)), false)
assert.equal(statUnchanged('f', 999, 10, 50, mk(100, 10, 50)), false)

// NULL stored ctime (legacy row, pre-migration) -> NOT unchanged -> force READ
// (condition 1: fail toward reading; the one-time re-read backfills ctime)
assert.equal(statUnchanged('f', 100, 10, 50, mk(100, 10, null)), false)

// absent path (new file) -> READ
assert.equal(statUnchanged('g', 100, 10, 50, mk(100, 10, 50)), false)

console.log('sync-manifest-ctime: statUnchanged ctime-gated matrix OK')
process.exit(0)
