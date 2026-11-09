/**
 * Session naming in core (19 Oct): /cortex-rename with no module installed,
 * the hand-over through the real dispatcher, the harness's own /rename, and
 * comms following both with its [role] extension.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { SessionNames } from '../core/sessionNames.js'
import { isolatedEnv } from './isolatedEnv.js'

const REPO = path.resolve(import.meta.dirname, '..')
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

test('the store: a pending title is handed over once; a changed title with nothing pending is a harness rename', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'session-names-'))
  dirs.push(d)
  const n = SessionNames.at(d)
  assert.equal(n.observe('s1', 'first'), undefined, 'first sight is recorded, not an event')
  assert.equal(n.observe('s1', 'first'), undefined)
  assert.deepEqual(n.observe('s1', 'renamed-in-harness'), { from: 'first', to: 'renamed-in-harness' })
  n.setPending('s1', 'via-cli')
  assert.equal(n.observe('s1', 'something-else'), undefined, 'while a rename is pending, a difference is not a harness rename')
  assert.equal(n.takePending('s1'), 'via-cli')
  assert.equal(n.takePending('s1'), undefined, 'once')
})

const env = (extra: Record<string, string> = {}) => {
  const e = isolatedEnv({ CLAUDE_CODE_SESSION_ID: 's1', CORTEX_TRACE: 'off', ...extra })
  dirs.push(e.root)
  return e.env
}
const rename = (e: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync(TSX, [path.join(REPO, 'bin', 'cortex-rename.ts'), ...args], { env: e, encoding: 'utf-8', cwd: REPO })
const hook = (e: NodeJS.ProcessEnv, event: string, payload: Record<string, unknown>) => {
  const r = spawnSync(TSX, [path.join(REPO, 'bin', 'cortex-hook.ts'), event], {
    env: { ...e, CLAUDE_CODE_ENTRYPOINT: 'cli' },
    encoding: 'utf-8',
    cwd: REPO,
    input: JSON.stringify({ hook_event_name: event, ...payload }),
  })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim() ? (JSON.parse(r.stdout) as { hookSpecificOutput?: Record<string, string> }) : {}
}

test('EMPTY CORTEX: rename works with no module, refuses a role argument, and the next prompt carries the title', () => {
  const e = env()
  const role = rename(e, 'docs-dev', 'docs')
  assert.equal(role.status, 2)
  assert.match(role.stderr, /cortex-rename takes one name; "docs" would need a module that extends it \(comms adds \[role\]\)/)

  const r = rename(e, 'docs-dev')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /the session title becomes docs-dev at your next prompt/)

  assert.equal(hook(e, 'UserPromptSubmit', { session_id: 's1', session_title: 'old' }).hookSpecificOutput?.sessionTitle, 'docs-dev')
  assert.equal(hook(e, 'UserPromptSubmit', { session_id: 's1', session_title: 'docs-dev' }).hookSpecificOutput?.sessionTitle, undefined, 'handed over once')
  assert.equal(rename({ ...e, CLAUDE_CODE_SESSION_ID: '' }, 'x').status, 1, 'outside Claude Code there is no session')
})

/** An install with comms over a mesh log (no daemon needed), and session s1 as member crew-1. */
const withComms = () => {
  const e = env({ CKN_COMMS_TRANSPORT: 'mesh', CKN_MACHINE: 'one-node' })
  const modules = path.join(e.CKN_STATE_DIR!, 'modules')
  fs.mkdirSync(modules, { recursive: true })
  fs.symlinkSync(path.join(REPO, 'modules', 'comms'), path.join(modules, 'comms'), 'dir')
  const join = spawnSync(TSX, [path.join(REPO, 'bin', 'cortex-role.ts'), 'join', 'crew', '--as', 'crew-1', '--create'], { env: e, encoding: 'utf-8', cwd: REPO })
  assert.equal(join.status, 0, join.stderr)
  return e
}
const who = (e: NodeJS.ProcessEnv) =>
  spawnSync(TSX, [path.join(REPO, 'bin', 'cortex-role.ts'), 'show', 'crew'], { env: e, encoding: 'utf-8', cwd: REPO }).stdout

test('WITH COMMS: the member follows, [role] joins under the new name, and the title is handed over', () => {
  const e = withComms()
  const r = rename(e, 'crew-lead', 'docs')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /renamed member crew-1 to crew-lead in crew/)
  assert.match(r.stdout, /created role docs \(it did not exist\) and joined as crew-lead/)
  assert.match(who(e), /crew-lead/)
  assert.equal(hook(e, 'UserPromptSubmit', { session_id: 's1', session_title: 'crew-1' }).hookSpecificOutput?.sessionTitle, 'crew-lead')
})

test("WITH COMMS: the harness's own /rename moves the member too, and is said in the context", () => {
  const e = withComms()
  hook(e, 'UserPromptSubmit', { session_id: 's1', session_title: 'crew-1' }) // core records the title it sees
  const out = hook(e, 'UserPromptSubmit', { session_id: 's1', session_title: 'crew-renamed' })
  assert.match(out.hookSpecificOutput?.additionalContext ?? '', /renamed member crew-1 to crew-renamed in crew/)
  assert.equal(out.hookSpecificOutput?.sessionTitle, undefined, 'comms does not set the old title back')
  assert.match(who(e), /crew-renamed/)
})

test("a session start re-syncs this user's commands to the checkout (a deploy run as another user cannot)", () => {
  const e = withComms()
  const cmds = path.join(e.CLAUDE_CONFIG_DIR!, 'commands')
  fs.mkdirSync(cmds, { recursive: true })
  // What a deploy left behind on 19 Oct: the old comms-owned rename command.
  fs.writeFileSync(path.join(cmds, 'cortex-rename.md'), 'old comms rename\n\n<!-- cortex:managed:comms -->\n')
  const hooked = (root: string) => JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `tsx ${path.join(root, 'bin', 'cortex-hook.ts')} SessionStart` }] }] } })
  fs.writeFileSync(path.join(e.CLAUDE_CONFIG_DIR!, 'settings.json'), hooked('/srv/other-checkout'))
  hook(e, 'SessionStart', { session_id: 's8', source: 'startup' })
  assert.match(fs.readFileSync(path.join(cmds, 'cortex-rename.md'), 'utf-8'), /old comms rename/, 'hooks of another checkout: left alone')
  fs.writeFileSync(path.join(e.CLAUDE_CONFIG_DIR!, 'settings.json'), hooked(REPO))
  hook(e, 'SessionStart', { session_id: 's9', source: 'startup' })
  const now = fs.readFileSync(path.join(cmds, 'cortex-rename.md'), 'utf-8')
  assert.match(now, /cortex:managed:core/)
  assert.match(now, /argument-hint: "<name> \[role\]"/)
  assert.ok(fs.existsSync(path.join(cmds, 'cortex-role.md')), "comms' own commands are installed too")
})

test('a session start never re-syncs from modules of another checkout (a dev run or its headless child, 27 Oct)', () => {
  const e = withComms()
  const cmds = path.join(e.CLAUDE_CONFIG_DIR!, 'commands')
  fs.mkdirSync(cmds, { recursive: true })
  fs.writeFileSync(path.join(cmds, 'cortex-rename.md'), 'old comms rename\n\n<!-- cortex:managed:comms -->\n')
  fs.writeFileSync(
    path.join(e.CLAUDE_CONFIG_DIR!, 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `tsx ${path.join(REPO, 'bin', 'cortex-hook.ts')} SessionStart` }] }] } }),
  )
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-other-modules-'))
  hook({ ...e, CKN_MODULES_DIR: elsewhere }, 'SessionStart', { session_id: 's10', source: 'startup' })
  assert.match(fs.readFileSync(path.join(cmds, 'cortex-rename.md'), 'utf-8'), /old comms rename/, 'left alone')
  fs.rmSync(elsewhere, { recursive: true, force: true })
})
