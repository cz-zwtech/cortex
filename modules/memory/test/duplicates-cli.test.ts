/**
 * `cortex-memory duplicates` end to end, in an isolated state dir: the flag
 * parsing is the part the in-process tests (retire.test.ts) do not reach.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import { isolatedEnv } from '../../../test/isolatedEnv.js'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const run = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-memory.ts'), ...args], { env, encoding: 'utf-8' })

test('duplicates lists a group dry, refuses a --keep outside any group, and --apply --keep retires the others', () => {
  const { env, root } = isolatedEnv({ CKN_MODULES_DIR: path.join(REPO, 'modules') })
  dirs.push(root)
  const memo = (body: string) => `---\nname: ledger-archive\ndescription: ${body.slice(0, 30)}\n---\n\n${body}\n`
  fs.writeFileSync(path.join(env.CKN_MEMORY_DIRS!, 'one.md'), memo('Archive the quarterly ledger exports to the glacier bucket for seven years.'))
  fs.writeFileSync(path.join(env.CKN_MEMORY_DIRS!, 'two.md'), memo('The office printer on the third floor needs the blue driver, not the grey one.'))
  assert.equal(run(env, 'sweep').status, 0)

  const dry = run(env, 'duplicates')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /ledger-archive {2}\(scope .*, 2 live rows\)/)
  assert.match(dry.stdout, /dry run: 1 row\(s\) would be retired/)
  const ids = [...dry.stdout.matchAll(/^ {2}(?:keep {2}|retire) {2}(\S+)/gm)].map((m) => m[1]!)
  assert.equal(ids.length, 2)

  const stray = run(env, 'duplicates', '--keep', 'no-such-id')
  assert.notEqual(stray.status, 0)
  assert.match(stray.stderr, /--keep names rows that are in no duplicate group: no-such-id/)

  const kept = ids[1]!
  const applied = run(env, 'duplicates', '--apply', '--keep', kept)
  assert.match(applied.stdout, /retired 1 row\(s\)/)
  assert.match(run(env, 'duplicates').stdout, /no duplicates/)
  assert.match(run(env, 'show', ids[0]!).stdout, new RegExp(`retired: .* superseded by ${kept}`))
})
