// Fixture for embeddings-warn.test.ts: print the resolved mode to stdout so the
// parent can assert on it; getEmbeddingMode's unrecognized-value warn goes to
// stderr. Run once per process so the module-level mode cache never collides.
import { getEmbeddingMode } from '../server/embeddings.js'
process.stdout.write(getEmbeddingMode())
