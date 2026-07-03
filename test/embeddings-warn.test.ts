import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// #139 B — an unrecognized CKN_EMBEDDINGS must fail safe to 'off' but WARN, so a
// typo can't silently disable embeddings. Explicit 'off' and truthy aliases must
// NOT warn. Each case runs in its own process because getEmbeddingMode caches.
const here = dirname(fileURLToPath(import.meta.url))
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx')
const fixture = join(here, '_print-embed-mode.ts')

const run = (val: string | undefined): { mode: string; warned: boolean } => {
  const env = { ...process.env }
  if (val === undefined) delete env.CKN_EMBEDDINGS
  else env.CKN_EMBEDDINGS = val
  const r = spawnSync(tsx, [fixture], { env, encoding: 'utf8' })
  return { mode: (r.stdout ?? '').trim(), warned: /not recognized/.test(r.stderr ?? '') }
}

// unrecognized -> off + warn
const garbage = run('garbage')
assert.equal(garbage.mode, 'off')
assert.equal(garbage.warned, true)

// explicit off -> off, NO warn (a deliberate choice isn't a footgun)
const off = run('off')
assert.equal(off.mode, 'off')
assert.equal(off.warned, false)

// truthy alias -> local, NO warn
const on = run('on')
assert.equal(on.mode, 'local')
assert.equal(on.warned, false)

// unset -> local default, NO warn
const unset = run(undefined)
assert.equal(unset.mode, 'local')
assert.equal(unset.warned, false)

console.log('embeddings-warn: warn matrix OK')
process.exit(0)
