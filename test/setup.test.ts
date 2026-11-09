import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { apply, decline, detect } from '../core/statuslineSetup.js'
import { statuslineLine, updateLine } from '../core/offers.js'
import { update, writePrefs } from '../core/update.js'
import { lockPath } from '../core/updateLock.js'
import { isolatedEnv } from './isolatedEnv.js'

const REPO = path.resolve(import.meta.dirname, '..')
const V2 = path.join(REPO, 'bin', 'cortex-statusline.sh')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-setup-'))
  dirs.push(d)
  return d
}

// The V1 snippet as the user's script carries it (rendering part).
const V1_SCRIPT = `#!/usr/bin/env bash
input=$(cat)
SESSION_ID=$(printf '%s' "$input" | jq -r '.session_id')
bus_watcher_armed() { return 1; }
mesh_seg() { printf '%s' "● mesh…"; }
if bus_watcher_armed "$SESSION_ID"; then
  BUS_SEG="● bus"
else
  BUS_SEG="● bus off"
fi
MESH_SEG=$(mesh_seg)
printf '%s %s %s' "my-model" "$BUS_SEG" "$MESH_SEG"
`

const rig = (statusLine?: { command: string }) => {
  const claudeDir = tmp()
  const file = path.join(claudeDir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify(statusLine ? { statusLine: { type: 'command', ...statusLine } } : {}))
  const readSettings = () => JSON.parse(fs.readFileSync(file, 'utf-8'))
  const writeSettings = (s: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify(s))
  return { claudeDir, file, readSettings, writeSettings, opts: (v2 = V2) => ({ claudeDir, v2Script: v2, readSettings, writeSettings, stamp: 't' }) }
}

const render = (command: string) =>
  spawnSync('bash', ['-c', command], {
    input: JSON.stringify({ session_id: 's' }),
    encoding: 'utf-8',
    env: isolatedEnv().env,
  }).stdout

test('detect tells empty, someone else\'s and Cortex\'s status lines apart; an old V1 script is just someone else\'s', () => {
  const d = tmp()
  const v1 = path.join(d, 'v1.sh')
  fs.writeFileSync(v1, V1_SCRIPT)
  const own = path.join(d, 'own.sh')
  fs.writeFileSync(own, 'echo mine\n')
  assert.equal(detect({}).kind, 'empty')
  assert.equal(detect({ statusLine: { command: `bash ${V2}` } }).kind, 'v2')
  assert.equal(detect({ statusLine: { command: `bash ${v1}` } }).kind, 'none')
  assert.equal(detect({ statusLine: { command: `bash ${own}` } }).kind, 'none')
  assert.equal(detect({ statusLine: { command: 'echo inline' } }).kind, 'none')
})

test('apply on a status line with no Cortex segment keeps the user\'s output and appends ours', () => {
  const d = tmp()
  const own = path.join(d, 'own.sh')
  fs.writeFileSync(own, 'cat >/dev/null; printf "my-model"\n')
  const r = rig({ command: `bash ${own}` })
  const res = apply(detect(r.readSettings()), r.opts())
  assert.ok(res.ok)
  const out = render(r.readSettings().statusLine.command)
  assert.match(out, /^my-model  /, 'their output first, untouched')
  assert.match(out, /cortex/)
  assert.equal(fs.readFileSync(own, 'utf-8'), 'cat >/dev/null; printf "my-model"\n', 'their script is not edited')
})

test('an edit that does not render is put back entirely', () => {
  const d = tmp()
  const script = path.join(d, 'statusline.sh')
  fs.writeFileSync(script, V1_SCRIPT)
  const r = rig({ command: `bash ${script}` })
  const before = fs.readFileSync(r.file, 'utf-8')
  const res = apply(detect(r.readSettings()), r.opts('/nonexistent/cortex-statusline.sh'))
  assert.equal(res.ok, false)
  assert.equal(fs.readFileSync(script, 'utf-8'), V1_SCRIPT)
  assert.equal(fs.readFileSync(r.file, 'utf-8'), before)
  assert.equal(fs.existsSync(path.join(r.claudeDir, 'cortex-statusline-wrap.sh')), false)
})

test('the session is asked once: a decline is remembered, and V2 says nothing', () => {
  const data = tmp()
  const d = tmp()
  const own = path.join(d, 'own.sh')
  fs.writeFileSync(own, 'echo mine\n')
  const claude = tmp()
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ statusLine: { command: `bash ${own}` } }))
  const env = { CLAUDE_CONFIG_DIR: claude }
  assert.match(statuslineLine(data, env)!, /no Cortex segment.*\/cortex-statusline apply/)
  decline(data, 'none')
  assert.equal(statuslineLine(data, env), undefined)
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ statusLine: { command: `bash ${V2}` } }))
  assert.equal(statuslineLine(tmp(), env), undefined)
})

test('update offers follow the mode, and a skipped version is not offered again', () => {
  const data = tmp()
  const last = { branch: 'v2/main', local: 'a', remote: 'b', behind: 2, checkedAt: Date.now() }
  writePrefs(data, { last })
  assert.match(updateLine(data)!, /Ask the user once.*\/cortex-update/)
  writePrefs(data, { mode: 'auto' })
  assert.match(updateLine(data)!, /Run \/cortex-update now/)
  writePrefs(data, { mode: 'off' })
  assert.equal(updateLine(data), undefined)
  writePrefs(data, { mode: 'ask', skipped: 'b' })
  assert.equal(updateLine(data), undefined)
})

// ── the update itself, against a real pair of git repos ─────────────────────

const sh = (cwd: string, cmd: string) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`)
  return r.stdout.trim()
}

const repos = () => {
  const root = tmp()
  const origin = path.join(root, 'origin')
  const work = path.join(root, 'work')
  sh(root, `git init -q -b v2/main origin && cd origin && git config user.email t@t && git config user.name t && echo '{}' > package.json && echo '{"v":1}' > package-lock.json && echo node_modules > .gitignore && git add . && git commit -qm one`)
  sh(root, `git clone -q origin work && cd work && git config user.email t@t && git config user.name t`)
  const push = (file: string, body: string) => sh(origin, `echo '${body}' > ${file} && git add . && git commit -qm ${file}`)
  return { origin, work, push, state: path.join(root, 'state') }
}

test('update fast-forwards, runs the post-update steps, and releases the lock', () => {
  const g = repos()
  g.push('feature.txt', 'new')
  let lockedDuring = false
  const r = update(g.work, g.state, {
    backup: () => ({ file: 'b' }),
    installDeps: () => assert.fail('the lockfile did not change'),
    postUpdate: () => {
      lockedDuring = fs.existsSync(lockPath(g.state))
    },
  })
  assert.equal(r.status, 'updated')
  assert.ok(fs.existsSync(path.join(g.work, 'feature.txt')))
  assert.ok(lockedDuring, 'hooks were paused while it ran')
  assert.equal(fs.existsSync(lockPath(g.state)), false)
})

test('a changed lockfile installs dependencies aside and swaps them in', () => {
  const g = repos()
  fs.mkdirSync(path.join(g.work, 'node_modules'))
  fs.writeFileSync(path.join(g.work, 'node_modules', 'old'), '')
  g.push('package-lock.json', '{"v":2}')
  const r = update(g.work, g.state, {
    backup: () => ({ file: 'b' }),
    installDeps: (dir) => {
      assert.notEqual(dir, g.work, 'never into the live checkout')
      fs.mkdirSync(path.join(dir, 'node_modules'))
      fs.writeFileSync(path.join(dir, 'node_modules', 'new'), '')
    },
    postUpdate: () => {},
  })
  assert.ok(r.status === 'updated' && r.depsReinstalled)
  assert.deepEqual(fs.readdirSync(path.join(g.work, 'node_modules')), ['new'])
  assert.deepEqual(fs.readdirSync(g.work).filter((f) => f.startsWith('.deps-staging') || f.includes('.old-')), [])
})

test('a dirty checkout is refused, and a failed step resets to where it was', () => {
  const g = repos()
  g.push('feature.txt', 'new')
  fs.writeFileSync(path.join(g.work, 'package.json'), '{"edited":true}')
  assert.equal(update(g.work, g.state).status, 'refused')
  sh(g.work, 'git checkout -q package.json')

  const before = sh(g.work, 'git rev-parse HEAD')
  assert.throws(() => update(g.work, g.state, { backup: () => ({ file: 'b' }), installDeps: () => {}, postUpdate: () => { throw new Error('install broke') } }), /reset to/)
  assert.equal(sh(g.work, 'git rev-parse HEAD'), before)
  assert.equal(fs.existsSync(lockPath(g.state)), false)
})

test('while an update holds the lock, the hook dispatcher exits quietly', () => {
  const { env, root } = isolatedEnv({ CKN_MODULES_DIR: path.join(REPO, 'modules') })
  dirs.push(root)
  fs.mkdirSync(env.CKN_STATE_DIR!, { recursive: true })
  fs.writeFileSync(lockPath(env.CKN_STATE_DIR!), JSON.stringify({ pid: process.pid }))
  const r = spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-hook.ts'), 'SessionStart'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'x' }),
    env,
    encoding: 'utf-8',
  })
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim(), '')
})

test('no update runs without a backup', () => {
  const g = repos()
  g.push('feature.txt', 'new')
  const before = sh(g.work, 'git rev-parse HEAD')
  const r = update(g.work, g.state, {
    backup: () => {
      throw new Error('disk full')
    },
    installDeps: () => assert.fail('must not get this far'),
    postUpdate: () => assert.fail('must not get this far'),
  })
  assert.deepEqual(r.status, 'refused')
  assert.match((r as { reason: string }).reason, /no update without a backup: disk full/)
  assert.equal(sh(g.work, 'git rev-parse HEAD'), before, 'nothing merged')
})

// ── the real update path, end to end, in a sandbox ───────────────────────────
// The unit tests above stub install; the --no-mesh-start bug lived exactly in
// the real install call they replaced, and every laptop update rolled back.

test('cortex-setup update, for real: pulls from a remote, installs, migrates', () => {
  const { env, root } = isolatedEnv()
  dirs.push(root)
  const origin = path.join(root, 'origin.git')
  const work = path.join(root, 'cortex-v2')
  const other = path.join(root, 'other')
  sh(root, `git clone -q --bare ${REPO} ${origin}`)
  // The checkout's HEAD as a branch of its own: a detached checkout has no branch name to clone.
  sh(root, `git -C ${REPO} push -q ${origin} HEAD:refs/heads/cortex-under-test`)
  sh(root, `git clone -q -b cortex-under-test ${origin} ${work}`)
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(work, 'node_modules'))
  fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), 'node_modules\n')
  sh(root, `git clone -q -b cortex-under-test ${origin} ${other}`)
  sh(other, 'git config user.email t@t && git config user.name t && echo upd > update-marker.txt && git add . && git commit -qm "an update" && git push -q')

  const r = spawnSync(path.join(work, 'node_modules', '.bin', 'tsx'), [path.join(work, 'bin', 'cortex-setup.ts'), 'update'], {
    cwd: work,
    env,
    encoding: 'utf-8',
    timeout: 240_000,
  })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /Cortex updated \w+ -> \w+/)
  assert.ok(fs.existsSync(path.join(work, 'update-marker.txt')), 'the new commit is checked out')
  const settings = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf-8'))
  assert.ok(JSON.stringify(settings.hooks).includes('cortex-hook.ts'), 'install ran for real')
  assert.ok(fs.readdirSync(path.join(env.CKN_STATE_DIR!, 'backups')).some((f) => f.endsWith('-update.tgz')), 'backed up first')
})

// ── laptop 2026-10-13: install replaced the user's wrapped status line ────────

test('a user status line survives apply, install, update and the clobbered case, and uninstall restores it', async () => {
  const { installStatusline, uninstallStatusline } = await import('../core/harness.js')
  const d = tmp()
  const own = path.join(d, 'statusline.sh')
  fs.writeFileSync(own, 'cat >/dev/null; printf "alexs-line"\n')
  const r = rig({ command: `bash ${own}` })
  const paths = { claudeDir: r.claudeDir, repoRoot: REPO, modulesDir: path.join(REPO, 'modules') }
  const shows = () => render(r.readSettings().statusLine.command)

  assert.ok(apply(detect(r.readSettings()), r.opts()).ok)
  assert.match(shows(), /^alexs-line  .*cortex/, 'after apply: theirs, then ours')

  await installStatusline(paths) // cortex-install
  assert.match(shows(), /^alexs-line  .*cortex/, 'after install')
  await installStatusline(paths) // /cortex-update runs install again
  assert.match(shows(), /^alexs-line  .*cortex/, 'after update')

  // The broken state the laptop was left in: our plain script in the slot.
  r.writeSettings({ statusLine: { type: 'command', command: `bash ${V2}` } })
  assert.equal((await installStatusline(paths)).healed, true)
  assert.match(shows(), /^alexs-line  .*cortex/, 'install puts their line back')

  assert.equal(await uninstallStatusline(paths), true)
  assert.equal(r.readSettings().statusLine.command, `bash ${own}`, 'uninstall restores their command')
  assert.equal(fs.existsSync(path.join(r.claudeDir, 'cortex-statusline-wrap.sh')), false)
})
