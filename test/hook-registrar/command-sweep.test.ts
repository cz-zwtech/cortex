#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// sweepRenamedCommands is pure FS logic (no DB / no server): import directly.
const { sweepRenamedCommands } = await import('../../server/hookRegistrar.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// A fake PROJECT_ROOT — the only thing that matters is that the Cortex bin
// signature is built from it the same way renderCommandFile / the COMMANDS
// bodies build it (path.join(PROJECT_ROOT,'node_modules','.bin','tsx')).
const PROJECT_ROOT = path.join(os.tmpdir(), 'fake-cortex-root')
const binTsx = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx')
const cknScript = path.join(PROJECT_ROOT, 'bin', 'ckn-snapshot.ts')

const mkTmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-sweep-'))

// A Cortex-owned command body carries the tsx bin path + a /bin/ckn- script path.
const cortexOwnedBody = (name: string): string =>
  ['---', `name: ${name}`, 'description: cortex command', '---', '', `Run: \`${binTsx} ${cknScript}\``, ''].join('\n')

// 1. Cortex-owned old file IS removed.
{
  const dir = mkTmp()
  fs.writeFileSync(path.join(dir, 'snapshot.md'), cortexOwnedBody('snapshot'), 'utf-8')
  const removed = sweepRenamedCommands(dir, PROJECT_ROOT)
  assert.ok(removed.includes('snapshot.md'), 'snapshot.md reported as removed')
  assert.ok(!fs.existsSync(path.join(dir, 'snapshot.md')), 'snapshot.md actually deleted')
  ok('cortex-owned old file removed')
}

// 2. User-owned same-named file (no bin signature) is NOT removed.
{
  const dir = mkTmp()
  const userBody = ['---', 'name: snapshot', 'description: my own command', '---', '', 'Do my custom thing.', ''].join('\n')
  fs.writeFileSync(path.join(dir, 'snapshot.md'), userBody, 'utf-8')
  const removed = sweepRenamedCommands(dir, PROJECT_ROOT)
  assert.ok(!removed.includes('snapshot.md'), 'user-owned snapshot.md NOT reported removed')
  assert.ok(fs.existsSync(path.join(dir, 'snapshot.md')), 'user-owned snapshot.md left in place')
  ok('user-owned same-named file preserved')
}

// 3. Already-absent old file → no-op, no throw.
{
  const dir = mkTmp()
  const removed = sweepRenamedCommands(dir, PROJECT_ROOT)
  assert.deepEqual(removed, [], 'nothing removed when no old files exist')
  ok('absent old file is a no-op')
}

// 3b. Missing commands dir → no-op, no throw.
{
  const missing = path.join(mkTmp(), 'does-not-exist')
  const removed = sweepRenamedCommands(missing, PROJECT_ROOT)
  assert.deepEqual(removed, [], 'missing commands dir → []')
  ok('missing commands dir is a no-op')
}

// 4. The sweep does not touch cortex-*.md (new) files, even if cortex-owned.
{
  const dir = mkTmp()
  fs.writeFileSync(path.join(dir, 'cortex-snapshot.md'), cortexOwnedBody('cortex-snapshot'), 'utf-8')
  fs.writeFileSync(path.join(dir, 'cortex-bus.md'), cortexOwnedBody('cortex-bus'), 'utf-8')
  const removed = sweepRenamedCommands(dir, PROJECT_ROOT)
  assert.deepEqual(removed, [], 'no new cortex-*.md files removed')
  assert.ok(fs.existsSync(path.join(dir, 'cortex-snapshot.md')), 'cortex-snapshot.md left')
  assert.ok(fs.existsSync(path.join(dir, 'cortex-bus.md')), 'cortex-bus.md left')
  ok('new cortex-*.md files untouched')
}

// 5. Mixed batch: removes all 8 cortex-owned old names, leaves a user one.
{
  const dir = mkTmp()
  const oldNames = ['sync-shared', 'snapshot', 'rename', 'bus', 'available', 'blast', 'codegraph-diff', 'profile-setup']
  for (const n of oldNames) fs.writeFileSync(path.join(dir, `${n}.md`), cortexOwnedBody(n), 'utf-8')
  // a user-owned 'bus.md' would be a conflict, so test a non-cortex 'rename.md' override:
  fs.writeFileSync(path.join(dir, 'rename.md'), 'my own rename command\n', 'utf-8')
  const removed = sweepRenamedCommands(dir, PROJECT_ROOT)
  assert.ok(!removed.includes('rename.md'), 'user-owned rename.md not removed')
  assert.ok(fs.existsSync(path.join(dir, 'rename.md')), 'user rename.md preserved')
  for (const n of oldNames.filter((x) => x !== 'rename')) {
    assert.ok(removed.includes(`${n}.md`), `${n}.md removed`)
    assert.ok(!fs.existsSync(path.join(dir, `${n}.md`)), `${n}.md gone`)
  }
  ok('mixed batch: 7 cortex-owned removed, 1 user preserved')
}

console.log(`\n${passed} assertions passed.`)
