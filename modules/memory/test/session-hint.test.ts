import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

// Through the real dispatcher: the hint is only useful if it reaches the model.
import { isolatedEnv } from '../../../test/isolatedEnv.js'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const sessionStart = (memoryBody: string | null, extraEnv: Record<string, string> = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hint-'))
  dirs.push(root)
  const mem = path.join(root, 'memory')
  fs.mkdirSync(mem)
  if (memoryBody) fs.writeFileSync(path.join(mem, 'a.md'), `---\nname: a\ntype: feedback\n---\n\n${memoryBody}\n`)
  const r = spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-hook.ts'), 'SessionStart'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'hint-test', cwd: root }),
    env: isolatedEnv({ CLAUDE_CODE_ENTRYPOINT: 'cli', CKN_STATE_DIR: path.join(root, 'state'), CKN_MODULES_DIR: path.join(REPO, 'modules'), CKN_MEMORY_DIRS: mem, ...extraEnv }).env,
    encoding: 'utf-8',
  })
  return r.stdout
}

test('a session with memories is told how to ask Cortex, not only what was injected', () => {
  const out = sessionStart('The release script lives at bin/release.sh and takes the tag as its argument.')
  assert.match(out, /1 of 1 memories loaded; use \/cortex-memory recall/)
  assert.match(out, /release script/)
})

test('an empty corpus injects nothing at all', () => {
  assert.doesNotMatch(sessionStart(null), /cortex-memory/)
})

test('a headless run gets no memory injection', () => {
  const out = sessionStart('The release script lives at bin/release.sh and takes the tag as its argument.', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
  assert.doesNotMatch(out, /cortex-memory|release script/)
})

test('a throwaway state dir never consumes the real memory files', () => {
  // The 2026-10-13 incident, reproduced safely: the "real" ~/.claude here is a
  // temp HOME. State is elsewhere and the memory roots are not declared.
  const { env, root } = isolatedEnv({ CKN_MODULES_DIR: path.join(REPO, 'modules'), CLAUDE_CODE_ENTRYPOINT: 'cli' })
  dirs.push(root)
  delete env.CKN_MEMORY_DIRS
  const file = path.join(env.CLAUDE_CONFIG_DIR!, 'memory', 'real.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = '---\nname: real\ntype: feedback\n---\n\nA real memory that must stay in its file.\n'
  fs.writeFileSync(file, body)
  spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-hook.ts'), 'SessionStart'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'iso', cwd: root }),
    env,
    encoding: 'utf-8',
  })
  assert.equal(fs.readFileSync(file, 'utf-8'), body)
})

const firstSweep = (breakBackups: boolean) => {
  const { env, root } = isolatedEnv({ CKN_MODULES_DIR: path.join(REPO, 'modules'), CLAUDE_CODE_ENTRYPOINT: 'cli' })
  dirs.push(root)
  const file = path.join(env.CKN_MEMORY_DIRS!, 'a.md')
  const body = '---\nname: a\ntype: feedback\n---\n\nA memory the first sweep should only consume after a backup.\n'
  fs.writeFileSync(file, body)
  if (breakBackups) {
    fs.mkdirSync(env.CKN_STATE_DIR!, { recursive: true })
    fs.writeFileSync(path.join(env.CKN_STATE_DIR!, 'backups'), 'not a directory')
  }
  spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-hook.ts'), 'SessionStart'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'fs', cwd: root }),
    env,
    encoding: 'utf-8',
  })
  return { file, body, state: env.CKN_STATE_DIR! }
}

test('the first sweep on a machine backs up before it changes any file', () => {
  const { file, body, state } = firstSweep(false)
  const backups = fs.readdirSync(path.join(state, 'backups')).filter((f) => f.endsWith('.tgz'))
  assert.equal(backups.length, 1)
  assert.match(spawnSync('tar', ['tzf', path.join(state, 'backups', backups[0]!)], { encoding: 'utf-8' }).stdout, /a\.md/)
  assert.notEqual(fs.readFileSync(file, 'utf-8'), body, 'then it consumed')
})

test('if that backup fails, the first sweep changes no file', () => {
  const { file, body } = firstSweep(true)
  assert.equal(fs.readFileSync(file, 'utf-8'), body)
})

// ── laptop 2026-10-14: the session-end sweep ────────

const hook = (event: string, env: NodeJS.ProcessEnv, cwd: string) =>
  spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-hook.ts'), event], {
    input: JSON.stringify({ hook_event_name: event, source: 'startup', session_id: 'mind', cwd }),
    env,
    encoding: 'utf-8',
  })

test('the session-end sweep runs detached and finishes after the hook has returned', async () => {
  const { env, root } = isolatedEnv({ CKN_MODULES_DIR: path.join(REPO, 'modules'), CLAUDE_CODE_ENTRYPOINT: 'cli' })
  dirs.push(root)
  // The real, non-test path: the dispatcher must hand off, not sweep inline.
  delete env.NODE_TEST_CONTEXT
  delete env.CORTEX_UNDER_TEST
  const file = path.join(env.CKN_MEMORY_DIRS!, 'canary.md')
  fs.writeFileSync(file, '---\nname: canary\n---\n\nThe laptop canary word is lemonade.\n')

  const started = Date.now()
  const r = hook('SessionEnd', env, root)
  assert.equal(r.status, 0)
  const log = path.join(env.CKN_STATE_DIR!, 'data', 'memory', 'sweeps.jsonl')
  for (let i = 0; i < 100 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf-8').includes('session-end')); i++) {
    await new Promise((res) => setTimeout(res, 200))
  }
  assert.match(fs.readFileSync(log, 'utf-8'), /"trigger":"session-end"/, `logged (${Date.now() - started}ms)`)
  assert.notEqual(fs.readFileSync(file, 'utf-8').trim().slice(0, 3), '---', 'the canary was swept')
  assert.ok(fs.existsSync(path.join(env.CKN_STATE_DIR!, 'data', 'memory', 'sweep-detached.log')), 'by the detached process, not inline')
})

test('list with a word prints usage instead of crashing', () => {
  const { env, root } = isolatedEnv({ CKN_MODULES_DIR: path.join(REPO, 'modules') })
  dirs.push(root)
  const r = spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-memory.ts'), 'list', 'ca7f76df'], { env, encoding: 'utf-8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /usage: cortex-memory list \[n\]/)
  assert.doesNotMatch(r.stderr, /SqliteError/)
})
