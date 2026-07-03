import assert from 'node:assert/strict'

// #139 B — getEmbeddingMode must accept truthy aliases for 'local' instead of
// fail-safing them to 'off' (the footgun that silently degraded a full-mode
// node when someone set CKN_EMBEDDINGS=on). The decision is extracted into a
// pure normalizer so it is testable without the module-level mode cache.
const { normalizeEmbeddingMode } = await import('../server/embeddings.js')

// recognized canonical modes pass through unchanged
assert.equal(normalizeEmbeddingMode('local'), 'local')
assert.equal(normalizeEmbeddingMode('remote'), 'remote')
assert.equal(normalizeEmbeddingMode('off'), 'off')

// truthy aliases normalize to local (the #139 B fix)
assert.equal(normalizeEmbeddingMode('on'), 'local')
assert.equal(normalizeEmbeddingMode('true'), 'local')
assert.equal(normalizeEmbeddingMode('1'), 'local')

// case- and whitespace-tolerant
assert.equal(normalizeEmbeddingMode('LOCAL'), 'local')
assert.equal(normalizeEmbeddingMode('  On  '), 'local')
assert.equal(normalizeEmbeddingMode('OFF'), 'off')

// unrecognized / empty -> off (fail-safe preserved)
assert.equal(normalizeEmbeddingMode('yes-please'), 'off')
assert.equal(normalizeEmbeddingMode('maybe'), 'off')
assert.equal(normalizeEmbeddingMode(''), 'off')

console.log('embeddings-mode: normalizeEmbeddingMode OK')
process.exit(0)
