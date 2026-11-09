/**
 * Phase 2B: the harness surface.
 *
 * These tests run against a THROWAWAY claudeDir in a temp directory. They never
 * touch a real ~/.claude. That is a hard constraint, not a preference: these
 * assertions read and rewrite settings.json, and a test that can damage a
 * user's harness config is worse than no test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  installHooks,
  uninstallHooks,
  syncCommands,
  installStatusCommand,
  commandGaps,
  installRenameCommand,
  syncClaudeImports,
  removeClaudeImports,
  importGaps,
  resyncCommands,
  syncCliShims,
  syncStatusSegments,
  uninstallStatusCommand,
  binDirOf,
  watchAllowRule,
  type HarnessPaths,
} from '../core/harness.js'
import { LIFECYCLE_EVENTS } from '../core/manifest.js'
import { CORTEX_MARKER } from '../core/settings.js'

const REPO = path.resolve(import.meta.dirname, '..')

const scratch = async (): Promise<HarnessPaths & { cleanup: () => Promise<void>; settings: string }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-harness-'))
  const claudeDir = path.join(root, 'dot-claude')
  await fs.mkdir(claudeDir, { recursive: true })
  return {
    claudeDir,
    repoRoot: REPO,
    modulesDir: path.join(root, 'modules'),
    settings: path.join(claudeDir, 'settings.json'),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

const installHelloWorld = async (modulesDir: string) => {
  await fs.mkdir(modulesDir, { recursive: true })
  await fs.symlink(path.join(REPO, 'examples', 'hello-world'), path.join(modulesDir, 'hello-world'), 'dir')
}

test('installing core registers exactly one hook per lifecycle event', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)

  await installHooks(p)
  const settings = JSON.parse(await fs.readFile(p.settings, 'utf-8'))

  assert.deepEqual(Object.keys(settings.hooks).sort(), [...LIFECYCLE_EVENTS].sort())
  for (const event of LIFECYCLE_EVENTS) {
    const groups = settings.hooks[event]
    assert.equal(groups.length, 1, `${event} must have exactly one registration`)
    assert.equal(groups[0].hooks.length, 1)
    assert.match(groups[0].hooks[0].command, /cortex-hook\.ts/)
    assert.equal(groups[0].hooks[0]._marker, CORTEX_MARKER)
  }
})

test('install is idempotent: twice is byte-identical', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)

  await installHooks(p)
  const first = await fs.readFile(p.settings, 'utf-8')
  await installHooks(p)
  const second = await fs.readFile(p.settings, 'utf-8')

  assert.equal(first, second)
})

test('installing PRESERVES user settings it did not write', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)

  await fs.writeFile(
    p.settings,
    JSON.stringify({
      model: 'opus',
      env: { MY_VAR: 'keep-me' },
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
      },
    }),
  )

  await installHooks(p)
  const settings = JSON.parse(await fs.readFile(p.settings, 'utf-8'))

  assert.equal(settings.model, 'opus', 'unrelated keys must survive')
  assert.deepEqual(settings.env, { MY_VAR: 'keep-me' })

  const commands = settings.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.map((h) => h.command),
  )
  assert.ok(commands.includes('echo user-hook'), "the user's own hook must survive")
  assert.ok(commands.some((c: string) => c.includes('cortex-hook.ts')))
})

test('a backup is written before the file is modified', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)

  await fs.writeFile(p.settings, JSON.stringify({ model: 'sonnet' }))
  await installHooks(p)

  const backup = JSON.parse(await fs.readFile(`${p.settings}.bak-cortex`, 'utf-8'))
  assert.deepEqual(backup, { model: 'sonnet' })
})

test('THE COORDINATION CLAIM: installing a module leaves settings.json byte-identical', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)

  await installHooks(p)
  const before = await fs.readFile(p.settings, 'utf-8')

  // Install a module and sync everything a module install would touch.
  await installHelloWorld(p.modulesDir)
  await syncCommands(p)

  const after = await fs.readFile(p.settings, 'utf-8')
  assert.equal(
    after,
    before,
    'module installs must not touch settings.json: this is the whole argument for coordinating over fanning out',
  )
})


test('install pre-approves the comms watcher, replaces a stale one, and uninstall removes only it', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)

  const stale = "Bash('/old place/node_modules/.bin/tsx' '/old place/bin/cortex-role.ts' watch)"
  await fs.writeFile(p.settings, JSON.stringify({ permissions: { allow: ['Skill(mine)', stale], defaultMode: 'auto' } }))

  await installHooks(p)
  let settings = JSON.parse(await fs.readFile(p.settings, 'utf-8'))
  assert.deepEqual(settings.permissions.allow, ['Skill(mine)', watchAllowRule(p)])
  assert.equal(watchAllowRule(p), `Bash(${REPO}/node_modules/.bin/tsx ${REPO}/bin/cortex-role.ts watch)`)
  assert.equal(settings.permissions.defaultMode, 'auto')

  await uninstallHooks(p)
  settings = JSON.parse(await fs.readFile(p.settings, 'utf-8'))
  assert.deepEqual(settings.permissions, { allow: ['Skill(mine)'], defaultMode: 'auto' })
})
test('uninstall removes our hooks and leaves the user their own', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)

  await fs.writeFile(
    p.settings,
    JSON.stringify({
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    }),
  )
  await installHooks(p)
  await uninstallHooks(p)

  const settings = JSON.parse(await fs.readFile(p.settings, 'utf-8'))
  const remaining = JSON.stringify(settings)
  assert.ok(!remaining.includes('cortex-hook.ts'), 'our hooks must be gone')
  assert.ok(remaining.includes('echo mine'), "the user's hook must remain")
})

test('module command contributions are installed, and removed when the module goes', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  await installHelloWorld(p.modulesDir)

  const first = await syncCommands(p)
  assert.deepEqual(first.installed, ['cortex-hello.md'])

  const body = await fs.readFile(path.join(p.claudeDir, 'commands', 'cortex-hello.md'), 'utf-8')
  assert.ok(body.includes(CORTEX_MARKER), 'installed commands must carry an ownership marker')

  // Second run changes nothing: idempotent.
  const second = await syncCommands(p)
  assert.deepEqual(second.installed, [])
  assert.deepEqual(second.removed, [])

  // Remove the module; its command must go with it.
  await fs.rm(path.join(p.modulesDir, 'hello-world'), { recursive: true, force: true })
  const third = await syncCommands(p)
  assert.deepEqual(third.removed, ['cortex-hello.md'])
  await assert.rejects(fs.access(path.join(p.claudeDir, 'commands', 'cortex-hello.md')))
})

test("command sync never deletes a user's own command file", async (t) => {
  const p = await scratch()
  t.after(p.cleanup)

  const mine = path.join(p.claudeDir, 'commands', 'my-own.md')
  await fs.mkdir(path.dirname(mine), { recursive: true })
  await fs.writeFile(mine, '# my own command\n')

  await syncCommands(p)

  assert.equal(await fs.readFile(mine, 'utf-8'), '# my own command\n')
})

test('core installs a read-only status command', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)

  const target = await installStatusCommand(p)
  const body = await fs.readFile(target, 'utf-8')

  assert.match(body, /cortex-status\.ts/)
  assert.match(body, /read-only/i)
  assert.ok(body.includes(CORTEX_MARKER))
})

test("syncCommands does not delete CORE's own command as an orphan", async (t) => {
  // The owner is recorded in the marker so removal never needs a list. An
  // earlier revision checked only that the marker was PRESENT, so core's status
  // command (owned by 'core', claimed by no module) was deleted immediately
  // after installStatusCommand wrote it. Install reported it installed and the
  // directory was empty; both statements were true about different moments.
  const p = await scratch()
  t.after(p.cleanup)

  const status = await installStatusCommand(p)
  const { removed } = await syncCommands(p)

  assert.deepEqual(removed, [], "nothing of core's was treated as an orphan")
  const body = await fs.readFile(status, 'utf-8')
  assert.match(body, new RegExp(`${CORTEX_MARKER}:core`), 'and it is still on disk')
})

test('an installed command names the real checkout path, not the placeholder', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  await fs.mkdir(p.modulesDir, { recursive: true })
  await fs.symlink(path.join(REPO, 'modules', 'comms'), path.join(p.modulesDir, 'comms'), 'dir')

  await syncCommands(p)
  const body = await fs.readFile(path.join(p.claudeDir, 'commands', 'cortex-role.md'), 'utf-8')

  assert.ok(!body.includes('{{CORTEX_REPO}}'), 'placeholder left unrendered')
  assert.ok(body.includes(path.join(REPO, 'bin', 'cortex-role.ts')))
  assert.ok(body.includes(`${CORTEX_MARKER}:comms`))
})

test('uninstall removes core\'s own status command too: install and uninstall are symmetric', async (t) => {
  const { uninstallStatusCommand } = await import('../core/harness.js')
  const p = await scratch()
  t.after(p.cleanup)
  await installStatusCommand(p)
  await fs.writeFile(path.join(p.claudeDir, 'commands', 'mine.md'), 'a user command\n')
  assert.equal(await uninstallStatusCommand(p), true)
  assert.deepEqual(await fs.readdir(path.join(p.claudeDir, 'commands')), ['mine.md'], 'only ours is removed')
  assert.equal(await uninstallStatusCommand(p), false, 'a second uninstall is a no-op')
})

test('memory contributes /cortex-memory, rendered with the real checkout path', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  await fs.mkdir(p.modulesDir, { recursive: true })
  await fs.symlink(path.join(REPO, 'modules', 'memory'), path.join(p.modulesDir, 'memory'), 'dir')

  await syncCommands(p)
  const body = await fs.readFile(path.join(p.claudeDir, 'commands', 'cortex-memory.md'), 'utf-8')

  assert.ok(body.includes(path.join(REPO, 'bin', 'cortex-memory.ts')))
  assert.ok(body.includes(`${CORTEX_MARKER}:memory`))
})

test('the status line is claimed only when empty, and released only when ours', async (t) => {
  const { installStatusline, uninstallStatusline } = await import('../core/harness.js')
  const p = await scratch()
  t.after(p.cleanup)
  const settings = path.join(p.claudeDir, 'settings.json')

  assert.equal((await installStatusline(p)).installed, true)
  assert.match(JSON.parse(await fs.readFile(settings, 'utf-8')).statusLine.command, /cortex-statusline\.sh/)
  assert.equal(await uninstallStatusline(p), true)
  assert.equal(JSON.parse(await fs.readFile(settings, 'utf-8')).statusLine, undefined)

  await fs.writeFile(settings, JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/statusline.sh' } }))
  const kept = await installStatusline(p)
  assert.equal(kept.installed, false)
  assert.equal(await uninstallStatusline(p), false)
  assert.equal(JSON.parse(await fs.readFile(settings, 'utf-8')).statusLine.command, 'bash ~/.claude/statusline.sh', "the user's line is untouched")
})

test('a command file Cortex does not own is never overwritten', async (t) => {
  // V1 ships /cortex-rename too; overwriting it during coexistence would lose
  // it, and V1's retire would no longer find it to back up.
  const p = await scratch()
  t.after(p.cleanup)
  await fs.mkdir(p.modulesDir, { recursive: true })
  await fs.symlink(path.join(REPO, 'modules', 'comms'), path.join(p.modulesDir, 'comms'), 'dir')
  await fs.mkdir(path.join(p.claudeDir, 'commands'), { recursive: true })
  const theirs = 'V1 rename\n\n<!-- cortex-managed -->\n'
  await fs.writeFile(path.join(p.claudeDir, 'commands', 'cortex-role.md'), theirs)

  const r = await syncCommands(p)

  assert.deepEqual(r.skipped, ['cortex-role.md'])
  assert.equal(await fs.readFile(path.join(p.claudeDir, 'commands', 'cortex-role.md'), 'utf-8'), theirs)
})

test('hook timeouts are written in seconds, as Claude Code reads them', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  await installHooks(p)
  const settings = JSON.parse(await fs.readFile(path.join(p.claudeDir, 'settings.json'), 'utf-8'))
  for (const groups of Object.values(settings.hooks) as { hooks: { timeout: number }[] }[][]) {
    for (const g of groups) for (const h of g.hooks) assert.ok(h.timeout >= 1 && h.timeout <= 60, `timeout ${h.timeout} is not seconds`)
  }
})

// ── laptop canary, 14 Oct: hooks died in sessions started outside the repo ───

test('the installed hook runs from any directory, with no npx and an empty npm cache', async (t) => {
  const { spawnSync } = await import('node:child_process')
  const { isolatedEnv } = await import('./isolatedEnv.js')
  const p = await scratch()
  t.after(p.cleanup)
  await installHooks({ ...p, repoRoot: REPO })
  const settings = JSON.parse(await fs.readFile(path.join(p.claudeDir, 'settings.json'), 'utf-8'))
  const command: string = settings.hooks.Stop[0].hooks[0].command
  assert.doesNotMatch(command, /\bnpx\b/, 'npx resolves tsx from the cwd and its cache')

  const { env, root } = isolatedEnv({ npm_config_cache: path.join(os.tmpdir(), `empty-npm-cache-${process.pid}`) })
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const nowhere = await fs.mkdtemp(path.join(os.tmpdir(), 'no-node-modules-'))
  t.after(() => fs.rm(nowhere, { recursive: true, force: true }))
  const r = spawnSync('bash', ['-c', command], { cwd: nowhere, env, input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'anywhere' }), encoding: 'utf-8', timeout: 20_000 })
  assert.equal(r.status, 0, r.stderr)
  const trace = await fs.readFile(path.join(env.CKN_STATE_DIR!, 'hook-trace.ndjson'), 'utf-8')
  assert.match(trace, /"event":"Stop"/, 'the dispatcher ran')
})

test('installed slash commands call the checkout\'s tsx, never npx', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  await fs.mkdir(p.modulesDir, { recursive: true })
  for (const m of ['comms', 'memory']) await fs.symlink(path.join(REPO, 'modules', m), path.join(p.modulesDir, m), 'dir')
  await syncCommands({ ...p, repoRoot: REPO })
  await installStatusCommand({ ...p, repoRoot: REPO })
  for (const f of await fs.readdir(path.join(p.claudeDir, 'commands'))) {
    const body = await fs.readFile(path.join(p.claudeDir, 'commands', f), 'utf-8')
    assert.doesNotMatch(body, /\bnpx tsx\b/, f)
    assert.ok(body.includes(path.join(REPO, 'node_modules', '.bin', 'tsx')), f)
  }
})

test("a name V1 held: status sees it shadowed, then missing once V1's file is gone, and a resync installs it", async (t) => {
  // 19 Oct: V1's cortex-role.md shadowed V2's at install; V1's purge deleted it; neither was left.
  const p = await scratch()
  t.after(p.cleanup)
  await fs.mkdir(p.modulesDir, { recursive: true })
  await fs.symlink(path.join(REPO, 'modules', 'comms'), path.join(p.modulesDir, 'comms'), 'dir')
  const cmds = path.join(p.claudeDir, 'commands')
  await fs.mkdir(cmds, { recursive: true })
  await fs.writeFile(path.join(cmds, 'cortex-role.md'), 'V1 rename\n\n<!-- cortex-managed -->\n')

  const first = await syncCommands(p)
  assert.deepEqual(first.skipped, ['cortex-role.md'])
  assert.deepEqual(await commandGaps(p), { missing: [], shadowed: ['cortex-role.md'] })

  await fs.rm(path.join(cmds, 'cortex-role.md')) // what V1's purge did
  assert.deepEqual(await commandGaps(p), { missing: ['cortex-role.md'], shadowed: [] })

  assert.equal(await resyncCommands(p, false), undefined, 'a service node (no hooks) gets no commands')
  assert.deepEqual((await commandGaps(p)).missing, ['cortex-role.md'])

  const r = await resyncCommands(p, true)
  assert.deepEqual(r!.installed, ['cortex-role.md'])
  assert.deepEqual(await commandGaps(p), { missing: [], shadowed: [] })
  assert.ok(await fs.stat(path.join(cmds, 'cortex-status.md')), 'core\'s own status command is there too')
  assert.deepEqual((await resyncCommands(p, true))!.installed, [], 'a second resync changes nothing')
})

test('core ships /cortex-rename; the [role] form shows only while a module that extends it is installed', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  const file = path.join(p.claudeDir, 'commands', 'cortex-rename.md')
  await installRenameCommand(p)
  const bare = await fs.readFile(file, 'utf-8')
  assert.match(bare, /argument-hint: "<name>"/)
  assert.doesNotMatch(bare, /\[role\]/)
  assert.match(bare, /cortex-rename\.ts'? \$ARGUMENTS/)
  assert.match(bare, new RegExp(`<!-- ${CORTEX_MARKER}:core -->`))

  await fs.mkdir(p.modulesDir, { recursive: true })
  await fs.symlink(path.join(REPO, 'modules', 'comms'), path.join(p.modulesDir, 'comms'), 'dir')
  await installRenameCommand(p)
  const ext = await fs.readFile(file, 'utf-8')
  assert.match(ext, /argument-hint: "<name> \[role\]"/)
  assert.match(ext, /- `\[role\]` \(comms\): also join this role under the new name/)

  const r = await syncCommands(p)
  assert.ok(!r.removed.includes('cortex-rename.md'), "core's own command is never a module orphan")
})

test("a rename command that is not ours (V1's) is left alone", async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  await fs.mkdir(path.join(p.claudeDir, 'commands'), { recursive: true })
  await fs.writeFile(path.join(p.claudeDir, 'commands', 'cortex-rename.md'), 'V1 rename\n')
  assert.equal(await installRenameCommand(p), undefined)
  assert.equal(await fs.readFile(path.join(p.claudeDir, 'commands', 'cortex-rename.md'), 'utf-8'), 'V1 rename\n')
})

test("CLAUDE.md imports: the user's text stays, the file always exists, a preserved file is imported until deleted, a rerun changes nothing", async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  await fs.mkdir(p.modulesDir, { recursive: true })
  await fs.symlink(path.join(REPO, 'modules', 'memory'), path.join(p.modulesDir, 'memory'), 'dir')
  const md = path.join(p.claudeDir, 'CLAUDE.md')
  const mine = '# Mine\nKeep this.\n\n## After\nAlso mine.\n'
  await fs.writeFile(md, mine)
  const kept = path.join(p.claudeDir, 'cortex', 'preserved-notes.md')
  await fs.mkdir(path.dirname(kept), { recursive: true })
  await fs.writeFile(kept, '## Notes\n- keep loading this\n')

  const first = await syncClaudeImports(p)
  const text = await fs.readFile(md, 'utf-8')
  const rules = path.join(p.claudeDir, 'cortex', 'rules.md')
  assert.ok(first.changed)
  assert.ok(text.includes('preserved-notes.md'), 'a preserved file is imported')
  assert.match(text, /# Mine\nKeep this\./)
  assert.match(text, /## After\nAlso mine\./)
  assert.ok(text.includes(`@${rules}`) || text.includes('@~/'), 'the import line')
  assert.ok((await fs.readFile(rules, 'utf-8')).trim(), 'the imported file exists and is not empty (a missing import is skipped silently)')
  assert.equal(await fs.readFile(md + '.before-cortex-imports', 'utf-8'), mine, 'backed up once, before the first change')
  assert.equal((await syncClaudeImports(p)).changed, false, 'a rerun changes nothing')
  await fs.rm(kept)
  assert.ok((await syncClaudeImports(p)).changed && !(await fs.readFile(md, 'utf-8')).includes('preserved-notes'), 'deleting the preserved file by hand drops its import')
  assert.deepEqual(await importGaps(p), [])

  await fs.writeFile(rules, '')
  assert.deepEqual(await importGaps(p), [rules], 'status sees an empty import')

  assert.equal(await removeClaudeImports(p), true)
  const after = await fs.readFile(md, 'utf-8')
  assert.doesNotMatch(after, /cortex:managed:imports/)
  assert.match(after, /Keep this\.[\s\S]*Also mine\./)
  assert.equal(await fs.stat(rules).catch(() => null), null, 'the file goes too')
})

test('uninstall puts preserved text back into CLAUDE.md rather than deleting it', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  await fs.mkdir(p.modulesDir, { recursive: true })
  await fs.symlink(path.join(REPO, 'modules', 'memory'), path.join(p.modulesDir, 'memory'), 'dir')
  const md = path.join(p.claudeDir, 'CLAUDE.md')
  await fs.writeFile(md, '# Mine\n\n<!-- cortex:managed:engagement -->\n## How to engage me\n- Lead with the result\n<!-- /cortex:managed:engagement -->\n')
  await syncClaudeImports(p)
  await removeClaudeImports(p)
  const after = await fs.readFile(md, 'utf-8')
  assert.match(after, /# Mine/)
  assert.match(after, /## How to engage me\n- Lead with the result/)
  assert.doesNotMatch(after, /cortex:managed:imports/)
})

test('CLI shims: a declared script lands on PATH beside claudeDir; a file Cortex did not write is left alone; an undeclared shim goes', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  await fs.mkdir(p.modulesDir, { recursive: true })
  await fs.symlink(path.join(REPO, 'modules', 'telegram'), path.join(p.modulesDir, 'telegram'), 'dir')
  await fs.symlink(path.join(REPO, 'modules', 'comms'), path.join(p.modulesDir, 'comms'), 'dir')
  const bin = binDirOf(p)
  assert.equal(bin, path.join(path.dirname(p.claudeDir), '.local', 'bin'), 'never the real ~/.local/bin under a test claudeDir')
  await fs.mkdir(bin, { recursive: true })
  await fs.writeFile(path.join(bin, 'cortex-old'), '#!/bin/sh\n# cortex:managed-shim (generated by Cortex; a resync rewrites or removes it)\n')
  await fs.writeFile(path.join(bin, 'cortex-mine'), '#!/bin/sh\necho mine\n')

  const r = await syncCliShims(p)
  assert.deepEqual(r, { written: ['cortex-role', 'cortex-mesh', 'cortex-telegram'], kept: [], removed: ['cortex-old'] })
  assert.match(await fs.readFile(path.join(bin, 'cortex-role'), 'utf-8'), new RegExp(`exec \\S+ ${path.join(REPO, 'bin', 'cortex-role.ts')} "\\$@"`), 'a core: entry runs core\'s script')
  const shim = path.join(bin, 'cortex-telegram')
  assert.equal((await fs.stat(shim)).mode & 0o777, 0o755)
  assert.match(await fs.readFile(shim, 'utf-8'), /exec .*node_modules\/\.bin\/tsx .*telegram\/bin\/cortex-telegram\.ts "\$@"/)
  assert.equal(await fs.readFile(path.join(bin, 'cortex-mine'), 'utf-8'), '#!/bin/sh\necho mine\n')
  assert.deepEqual(await syncCliShims(p), { written: [], kept: [], removed: [] }, 'a rerun changes nothing')

  await fs.writeFile(shim, '#!/bin/sh\necho not ours\n')
  assert.deepEqual((await syncCliShims(p)).kept, ['cortex-telegram'], 'someone else\'s cortex-telegram is never overwritten')
})

test('core installs its own statusline and update commands, marked as core\'s, and uninstall takes them', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  await installStatusCommand({ ...p, repoRoot: REPO })
  for (const f of ['cortex-statusline.md', 'cortex-update.md']) assert.match(await fs.readFile(path.join(p.claudeDir, 'commands', f), 'utf-8'), /cortex:managed:core/, f)
  await uninstallStatusCommand({ ...p, repoRoot: REPO })
  for (const f of ['cortex-statusline.md', 'cortex-update.md', 'cortex-status.md']) await assert.rejects(fs.stat(path.join(p.claudeDir, 'commands', f)), f)
})

test('status line segments: each installed module that declares one is linked in order; a module gone takes its link; a file not ours stays', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  const segmentsDir = path.join(path.dirname(p.modulesDir), 'statusline.d')
  await fs.mkdir(p.modulesDir, { recursive: true })
  for (const m of ['comms', 'memory', 'telegram']) await fs.symlink(path.join(REPO, 'modules', m), path.join(p.modulesDir, m), 'dir')
  assert.deepEqual(await syncStatusSegments(p), { linked: ['10-memory.sh', '20-comms.sh'], removed: [] })
  assert.equal(await fs.readlink(path.join(segmentsDir, '20-comms.sh')), path.join(p.modulesDir, 'comms', 'statusline.sh'))
  await fs.writeFile(path.join(segmentsDir, '30-mine.sh'), 'echo mine')
  await fs.rm(path.join(p.modulesDir, 'comms'))
  assert.deepEqual(await syncStatusSegments(p), { linked: [], removed: ['20-comms.sh'] })
  assert.deepEqual((await fs.readdir(segmentsDir)).sort(), ['10-memory.sh', '30-mine.sh'])
})

test('the updater runs what installed modules declare around an update, core naming none', async (t) => {
  const p = await scratch()
  t.after(p.cleanup)
  await fs.mkdir(p.modulesDir, { recursive: true })
  for (const m of ['comms', 'memory', 'telegram']) await fs.symlink(path.join(REPO, 'modules', m), path.join(p.modulesDir, m), 'dir')
  const { moduleSteps } = await import('../core/update.js')
  assert.deepEqual(moduleSteps(p.modulesDir, 'before').map((x) => `${x.module}: ${x.command}`), ['comms: core:bin/cortex-mesh.ts pause'])
  assert.deepEqual(moduleSteps(p.modulesDir, 'after').map((x) => `${x.module}: ${x.command}`), ['comms: core:bin/cortex-mesh.ts resume', 'memory: core:bin/cortex-memory.ts reindex --apply'])
})
