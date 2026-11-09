/**
 * Harness integration — the part of core that touches the user's Claude Code
 * install.
 *
 * The coordination model, made real:
 *
 *   core registers ONE hook per lifecycle event, pointing at core's dispatcher.
 *   Modules register nothing. Installing or removing a module leaves
 *   settings.json byte-identical.
 *
 * That last property is the whole argument for coordinating over fanning out,
 * and until this file existed it was true only because nothing wrote
 * settings.json at all — a property that holds because a feature is absent is
 * not evidence. `installHooks` is written to be idempotent precisely so the
 * claim can be tested rather than asserted.
 *
 * Commands are the opposite case: they ARE per-module, so installing a module
 * adds command files. Uninstall symmetry matters — we remove exactly what we
 * installed, tracked by a marker in the file itself rather than by a hardcoded
 * name list (V1 kept two hand-maintained lists that both went stale).
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import { runScript, shellQuote, tsxBin } from './paths.js'
import path from 'node:path'
import { LIFECYCLE_EVENTS } from './manifest.js'
import {
  readSettings,
  writeSettings,
  registerHooks,
  unregisterHooks,
  registerAllow,
  unregisterAllow,
  CORTEX_MARKER,
} from './settings.js'
import { discover } from './discover.js'

/**
 * Declared per-event harness timeout, ms.
 *
 * THIS NUMBER IS THE WORST STALL A USER CAN EXPERIENCE, so it is chosen rather
 * than defaulted. The harness timeout is the ONLY real watchdog for a hook
 * process: a synchronous syscall that hangs blocks the event loop, so no
 * in-process timer can fire — the same no-preemption fact that made the
 * per-subscriber budget observe-not-enforce, one level down. Measured: an
 * in-container hang under /proc that `existsSync` now avoids, and which nothing
 * inside this process could have rescued.
 *
 * 5s against a measured ~450ms worst case under a real harness (tsx startup
 * included, zero subscribers) — roughly 10x headroom, while halving the stall
 * a user eats when something genuinely wedges. Raise it only with a measurement,
 * and remember what you are raising.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000

/**
 * The timeout written into settings.json, in SECONDS: Claude Code reads hook
 * timeouts in seconds. 5000 was written here once, meaning milliseconds, which
 * gave every hook 83 minutes to hang a prompt. The dispatcher keeps its own
 * 5s budget inside this; 10s leaves it headroom.
 */
export const SETTINGS_HOOK_TIMEOUT_S = 10

export type HarnessPaths = {
  /** The harness config root, e.g. ~/.claude. NEVER a real one during tests. */
  claudeDir: string
  /** Where core's dispatcher script lives. */
  repoRoot: string
  /** Where modules are installed. */
  modulesDir: string
  /** Where CLI shims go; by default ~/.local/bin beside claudeDir, so a test's temp claudeDir keeps them out of the real one. */
  binDir?: string
  /** Where status line segments are linked; by default <state>/statusline.d, beside the modules dir. */
  segmentsDir?: string
}

const commandsDir = (p: HarnessPaths) => path.join(p.claudeDir, 'commands')
const settingsFile = (p: HarnessPaths) => path.join(p.claudeDir, 'settings.json')

/**
 * The dispatcher invocation the harness will run.
 *
 * Command form only, never an args array: an args array switches the harness to
 * exec form and skips shell expansion, which breaks any indirection in the
 * path. V1 learned this and documented it; encoding it here keeps it learned.
 */
export const dispatcherCommand = (p: HarnessPaths, event: string): string =>
  `${runScript(p.repoRoot, 'cortex-hook.ts')} ${event}`

/**
 * The comms watcher, pre-approved. Sessions re-arm it every 30 minutes; in auto
 * mode each re-arm otherwise waits on the server-side classifier, and when that
 * gives no verdict the watcher stays down (25 Oct: four failures in a row). A
 * Monitor runs its command through Bash, so the rule is a Bash rule, and an
 * exact command, never a prefix: auto mode drops broad Bash rules anyway.
 */
export const watchAllowRule = (p: Pick<HarnessPaths, 'repoRoot'>): string => `Bash(${runScript(p.repoRoot, 'cortex-role.ts')} watch)`
const isWatchRule = (rule: string): boolean => /^Bash\(.+\/bin\/cortex-role\.ts'? watch\)$/.test(rule)

export type InstallResult = {
  settingsFile: string
  events: string[]
  commandsInstalled: string[]
  commandsRemoved: string[]
}

/**
 * Register core's hooks. Idempotent: running twice produces byte-identical
 * output, which is what makes the install-a-module-changes-nothing assertion
 * meaningful.
 */
export const installHooks = async (p: HarnessPaths): Promise<InstallResult> => {
  const file = settingsFile(p)
  const current = await readSettings(file)
  const next = registerHooks(
    current,
    LIFECYCLE_EVENTS,
    (event) => dispatcherCommand(p, event),
    SETTINGS_HOOK_TIMEOUT_S,
  )
  await writeSettings(file, registerAllow(next, [watchAllowRule(p)], isWatchRule))
  return {
    settingsFile: file,
    events: [...LIFECYCLE_EVENTS],
    commandsInstalled: [],
    commandsRemoved: [],
  }
}

export const uninstallHooks = async (p: HarnessPaths): Promise<void> => {
  const file = settingsFile(p)
  const current = await readSettings(file)
  await writeSettings(file, unregisterAllow(unregisterHooks(current), isWatchRule))
}

/**
 * Fill install-time paths into a module's command file.
 *
 * A command file is static markdown, but the CLI it runs lives wherever this
 * checkout was cloned, which differs per machine (/srv/cortex/cortex-v2 on home, a
 * drvfs path on hub). `{{CORTEX_REPO}}` is the one placeholder, resolved at
 * install so the installed command names a real path.
 */
export const renderCommand = (body: string, p: Pick<HarnessPaths, 'repoRoot'>): string =>
  body.replaceAll('{{CORTEX_TSX}}', shellQuote(tsxBin(p.repoRoot))).replaceAll('{{CORTEX_REPO}}', p.repoRoot)

/** The module that owns a command file, from its marker. Null when not ours. */
const markerOwner = (body: string): string | null => {
  const m = body.match(new RegExp(`${CORTEX_MARKER}:([A-Za-z0-9_.-]+)`))
  return m ? m[1]! : null
}

/**
 * Sync command files to match what is installed.
 *
 * Both directions in one pass: contributions from installed modules are
 * written, and any command we previously installed whose module is gone is
 * removed. Ownership is recorded IN the file (an HTML comment carrying the
 * marker and the owning module), so uninstall never depends on a list that can
 * drift from reality.
 */
export const syncCommands = async (
  p: HarnessPaths,
): Promise<{ installed: string[]; removed: string[]; skipped: string[] }> => {
  const dir = commandsDir(p)
  await fs.mkdir(dir, { recursive: true })

  const { found } = await discover(p.modulesDir)

  const desired = new Map<string, { module: string; body: string }>()
  for (const { dir: moduleDir, manifest } of found) {
    for (const cmd of manifest.commands) {
      let body: string
      try {
        body = await fs.readFile(path.join(moduleDir, cmd.file), 'utf-8')
      } catch {
        // A manifest naming a command file that does not exist is a defect in
        // that module. Skip it rather than installing an empty command, and
        // leave the module otherwise working.
        continue
      }
      desired.set(`cortex-${cmd.sub}.md`, {
        module: manifest.name,
        body: `${renderCommand(body, p).trimEnd()}\n\n<!-- ${CORTEX_MARKER}:${manifest.name} -->\n`,
      })
    }
  }

  const installed: string[] = []
  const removed: string[] = []
  const skipped: string[] = []

  for (const [name, { body }] of desired) {
    const target = path.join(dir, name)
    let existing: string | null = null
    try {
      existing = await fs.readFile(target, 'utf-8')
    } catch {
      /* not installed yet */
    }
    // A command file without our marker is someone else's: the user's, or V1's
    // while it is still installed (both ship /cortex-rename). Overwriting it
    // would lose it, and V1's retire would then not find it to back up.
    if (existing !== null && !existing.includes(CORTEX_MARKER)) {
      skipped.push(name)
      continue
    }
    if (existing !== body) {
      await fs.writeFile(target, body, 'utf-8')
      installed.push(name)
    }
  }

  // Remove ours that are no longer wanted. Files without our marker are the
  // user's own and are never touched.
  //
  // THE OWNER IS READ FROM THE FILE rather than inferred from absence. The
  // marker records `cortex:managed:<owner>` precisely so removal never depends
  // on a list that can drift — and an earlier revision then checked only whether
  // the marker was PRESENT, which made every marked file no module currently
  // claims an orphan. That deleted core's own `cortex-status` command
  // immediately after `installStatusCommand` wrote it: install reported the
  // command installed, the directory was empty, and both were telling the truth
  // about different moments.
  //
  // Same shape as discovery's `rejected` list being dropped by its consumer: the
  // information was already there and nothing read it.
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    /* no commands dir */
  }
  for (const name of entries) {
    if (desired.has(name)) continue
    const target = path.join(dir, name)
    try {
      const body = await fs.readFile(target, 'utf-8')
      const owner = markerOwner(body)
      if (!owner) continue // not ours
      if (owner === 'core') continue // core's own surface is never an orphan
      await fs.rm(target)
      removed.push(name)
    } catch {
      /* unreadable — leave it alone */
    }
  }

  return { installed, removed, skipped }
}

/**
 * Installed modules' commands that are not in the commands dir as ours:
 * `missing` (no file) or `shadowed` (a file without our marker holds the name,
 * so sync skips it). Read-only, for status.
 *
 * Found on 19 Oct: V1's own cortex-rename.md shadowed V2's at install, then
 * V1's purge deleted it, and the owner had neither on two machines with nothing
 * saying so.
 */
export const commandGaps = async (p: HarnessPaths): Promise<{ missing: string[]; shadowed: string[] }> => {
  const { found } = await discover(p.modulesDir)
  const missing: string[] = []
  const shadowed: string[] = []
  for (const { manifest } of found) {
    for (const cmd of manifest.commands) {
      const name = `cortex-${cmd.sub}.md`
      let body: string
      try {
        body = await fs.readFile(path.join(commandsDir(p), name), 'utf-8')
      } catch {
        missing.push(name)
        continue
      }
      if (!body.includes(CORTEX_MARKER)) shadowed.push(name)
    }
  }
  return { missing: missing.sort(), shadowed: shadowed.sort() }
}

/**
 * Re-sync the command surface of a user install, after anything that can free a
 * name (V1's retire or purge) or change what modules ship (an update). A
 * service node has no hooks, so no commands, and is left alone.
 */
export const resyncCommands = async (p: HarnessPaths, hooked: boolean): Promise<{ installed: string[]; skipped: string[] } | undefined> => {
  if (!hooked) return undefined
  await installStatusCommand(p)
  const r = await syncCommands(p)
  await installRenameCommand(p)
  await syncClaudeImports(p)
  await syncCliShims(p)
  await syncStatusSegments(p)
  return { installed: r.installed, skipped: r.skipped }
}

// ── status line segments ────────────────────────────────────────────────────

export const segmentsDirOf = (p: HarnessPaths) => p.segmentsDir ?? path.join(path.dirname(p.modulesDir), 'statusline.d')

/**
 * Core's status line prints only "cortex"; each installed module that declares a segment adds its part
 * (2 Nov 2026: like settings.json, a small base that installs extend). Linked as <order>-<module>.sh to
 * the module's script, so a module removed leaves nothing behind: its link goes at the next sync.
 */
export const syncStatusSegments = async (p: HarnessPaths): Promise<{ linked: string[]; removed: string[] }> => {
  const { found } = await discover(p.modulesDir)
  const dir = segmentsDirOf(p)
  const want = new Map<string, string>(
    found.flatMap(({ dir: mod, manifest }) =>
      manifest.statusline ? [[`${String(manifest.statusline.order).padStart(2, '0')}-${manifest.name}.sh`, path.join(mod, manifest.statusline.script)] as const] : [],
    ),
  )
  const linked: string[] = []
  const removed: string[] = []
  if (want.size) await fs.mkdir(dir, { recursive: true })
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const file = path.join(dir, name)
    if (!(await fs.lstat(file)).isSymbolicLink()) continue // not ours
    if (want.get(name) === (await fs.readlink(file).catch(() => ''))) continue
    await fs.rm(file)
    removed.push(name)
  }
  for (const [name, target] of want) {
    const file = path.join(dir, name)
    if ((await fs.readlink(file).catch(() => '')) === target) continue
    await fs.symlink(target, file)
    linked.push(name)
  }
  return { linked: linked.sort(), removed: removed.sort() }
}

// ── CLI shims ───────────────────────────────────────────────────────────────

const SHIM_MARK = '# cortex:managed-shim (generated by Cortex; a resync rewrites or removes it)'
export const binDirOf = (p: HarnessPaths) => p.binDir ?? path.join(path.dirname(p.claudeDir), '.local', 'bin')

/**
 * A shim on PATH for every script installed modules declare (`cli`), so a notice
 * can say `cortex-telegram ...` and it runs on any user node. A file Cortex did not
 * write is never touched; a managed shim no module declares any more is removed.
 */
export const syncCliShims = async (p: HarnessPaths): Promise<{ written: string[]; kept: string[]; removed: string[] }> => {
  const { found } = await discover(p.modulesDir)
  const dir = binDirOf(p)
  const script = (mod: string, f: string) => (f.startsWith('core:') ? path.join(p.repoRoot, f.slice('core:'.length)) : path.join(mod, f))
  const want = new Map(found.flatMap(({ dir: mod, manifest }) => manifest.cli.map((f) => [path.basename(f, '.ts'), script(mod, f)] as const)))
  const written: string[] = []
  const kept: string[] = []
  const removed: string[] = []
  const managed = async (f: string) => (await fs.readFile(f, 'utf-8').catch(() => '')).includes(SHIM_MARK)
  if (want.size) await fs.mkdir(dir, { recursive: true })
  for (const [name, script] of want) {
    const file = path.join(dir, name)
    const exists = !!(await fs.lstat(file).catch(() => null))
    if (exists && !(await managed(file))) {
      kept.push(name)
      continue
    }
    const body = `#!/bin/sh\n${SHIM_MARK}\nexec ${shellQuote(tsxBin(p.repoRoot))} ${shellQuote(script)} "$@"\n`
    if ((await fs.readFile(file, 'utf-8').catch(() => '')) !== body) {
      await fs.writeFile(file, body, { mode: 0o755 })
      written.push(name)
    }
  }
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith('cortex-') && !want.has(name) && (await managed(path.join(dir, name)))) {
      await fs.rm(path.join(dir, name))
      removed.push(name)
    }
  }
  return { written, kept, removed }
}

// ── CLAUDE.md imports ────────────────────────────────────────────────────────

const IMPORTS_OPEN = '<!-- cortex:managed:imports (generated by Cortex; edit the source memories, not this block) -->'
const IMPORTS_CLOSE = '<!-- /cortex:managed:imports -->'

export const importsDir = (p: Pick<HarnessPaths, 'claudeDir'>) => path.join(p.claudeDir, 'cortex')
/** Files in importsDir with this prefix are text Cortex took over from elsewhere: imported until deleted by hand. */
const PRESERVED_PREFIX = 'preserved-'


/** How CLAUDE.md names the file: home-relative when it is under home (E1: both forms load from the user file). */
const importRef = (file: string) => {
  const home = os.homedir()
  return file.startsWith(home + path.sep) ? `@~/${path.relative(home, file)}` : `@${file}`
}

const PLACEHOLDER = (name: string) => `<!-- Cortex writes ${name}; nothing in it yet. -->\n(Nothing yet.)\n`

/**
 * The import block in the user's CLAUDE.md, for every file installed modules
 * declare (`claudeImports`). Each file is created if missing or empty, because
 * the harness skips a missing import silently (E1). Files someone placed as
 * preserved-*.md are imported too, until deleted by hand. CLAUDE.md is backed up
 * once, before Cortex first changes it.
 */
export const syncClaudeImports = async (p: HarnessPaths): Promise<{ files: string[]; changed: boolean }> => {
  const { found } = await discover(p.modulesDir)
  const target = path.join(p.claudeDir, 'CLAUDE.md')
  const current = await fs.readFile(target, 'utf-8').catch(() => '')
  const preserved = (await fs.readdir(importsDir(p)).catch(() => [] as string[])).filter((n) => n.startsWith(PRESERVED_PREFIX) && n.endsWith('.md'))
  const names = [...new Set([...found.flatMap(({ manifest }) => manifest.claudeImports), ...preserved])].sort()
  const files = names.map((n) => path.join(importsDir(p), n))
  for (const f of files) {
    const now = await fs.readFile(f, 'utf-8').catch(() => '')
    if (!now.trim()) {
      await fs.mkdir(path.dirname(f), { recursive: true })
      await fs.writeFile(f, PLACEHOLDER(path.basename(f)), 'utf-8')
    }
  }
  const before = current
  const block = files.length ? `${IMPORTS_OPEN}\n${files.map(importRef).join('\n')}\n${IMPORTS_CLOSE}\n` : ''
  const open = before.indexOf(IMPORTS_OPEN)
  const close = before.indexOf(IMPORTS_CLOSE)
  let after: string
  if (open >= 0 && close > open) {
    after = before.slice(0, open) + block + before.slice(close + IMPORTS_CLOSE.length).replace(/^\n/, '')
  } else {
    after = block ? `${before}${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${block}` : before
  }
  if (after === before) return { files, changed: false }
  const backup = path.join(p.claudeDir, 'CLAUDE.md.before-cortex-imports')
  if (before && !(await fs.stat(backup).catch(() => null))) await fs.writeFile(backup, before, 'utf-8')
  await fs.writeFile(target, after, 'utf-8')
  return { files, changed: true }
}

/** Uninstall: the block goes, and so do the files Cortex wrote for it. */
export const removeClaudeImports = async (p: HarnessPaths): Promise<boolean> => {
  const target = path.join(p.claudeDir, 'CLAUDE.md')
  const before = await fs.readFile(target, 'utf-8').catch(() => '')
  const open = before.indexOf(IMPORTS_OPEN)
  const close = before.indexOf(IMPORTS_CLOSE)
  // Text Cortex preserved from elsewhere goes back where it was, not away with Cortex.
  const preserved: string[] = []
  for (const n of (await fs.readdir(importsDir(p)).catch(() => [] as string[])).filter((x) => x.startsWith(PRESERVED_PREFIX)).sort()) {
    preserved.push((await fs.readFile(path.join(importsDir(p), n), 'utf-8')).replace(/^<!--[^\n]*-->\n?/, ''))
  }
  await fs.rm(importsDir(p), { recursive: true, force: true })
  if (open < 0 || close < open) return false
  await fs.writeFile(target, before.slice(0, open) + preserved.join('\n') + before.slice(close + IMPORTS_CLOSE.length).replace(/^\n/, ''), 'utf-8')
  return true
}

/** For status: imports in the block whose file is missing or empty (the harness would skip them silently). */
export const importGaps = async (p: Pick<HarnessPaths, 'claudeDir'>): Promise<string[]> => {
  const text = await fs.readFile(path.join(p.claudeDir, 'CLAUDE.md'), 'utf-8').catch(() => '')
  const open = text.indexOf(IMPORTS_OPEN)
  const close = text.indexOf(IMPORTS_CLOSE)
  if (open < 0 || close < open) return []
  const refs = text.slice(open, close).split('\n').filter((l) => l.startsWith('@'))
  const gaps: string[] = []
  for (const ref of refs) {
    const f = ref.startsWith('@~/') ? path.join(os.homedir(), ref.slice(3)) : ref.slice(1)
    const body = await fs.readFile(f, 'utf-8').catch(() => '')
    if (!body.trim()) gaps.push(f)
  }
  return gaps
}

/**
 * Remove core's own status command, if it is ours.
 *
 * `syncCommands` only removes MODULE-owned files, by design, so uninstall left
 * cortex-status.md behind: an uninstall that is not symmetric with install,
 * which is exactly what the pristine-baseline UAT exists to catch.
 */
export const uninstallStatusCommand = async (p: HarnessPaths): Promise<boolean> => {
  let removed = false
  for (const name of ['cortex-status.md', 'cortex-rename.md', ...(await coreCommandFiles(p)).map((f) => `cortex-${path.basename(f, '.md')}.md`)]) {
    const target = path.join(commandsDir(p), name)
    try {
      const body = await fs.readFile(target, 'utf-8')
      if (markerOwner(body) !== 'core') continue
      await fs.rm(target)
      if (name === 'cortex-status.md') removed = true
    } catch {
      /* not there */
    }
  }
  return removed
}

/**
 * Core's `/cortex-rename`. Works with no module installed; each installed
 * module's extension (`extends`) adds its argument form and a line saying what
 * it does, so the text matches what will actually happen.
 *
 * Returns the file written, or undefined when a file that is not ours holds the
 * name (V1's, or the user's), which is left alone like any module command.
 */
export const installRenameCommand = async (p: HarnessPaths): Promise<string | undefined> => {
  const dir = commandsDir(p)
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, 'cortex-rename.md')
  try {
    if (!(await fs.readFile(target, 'utf-8')).includes(CORTEX_MARKER)) return undefined
  } catch {
    /* not installed yet */
  }
  const { found } = await discover(p.modulesDir)
  const ext = found.flatMap(({ manifest }) => manifest.extends.filter((e) => e.command === 'rename').map((e) => ({ ...e, module: manifest.name })))
  const form = ['<name>', ...ext.map((e) => e.args)].join(' ')
  const body = [
    '---',
    `description: Name this session - rename ${form}. Use it yourself when the user names this session or tells it what it is in plain words ("you are the docs dev").`,
    `argument-hint: "${form}"`,
    '---',
    '',
    'Run this command and show the user its output:',
    '',
    '```bash',
    `${runScript(p.repoRoot, 'cortex-rename.ts')} $ARGUMENTS`,
    '```',
    '',
    '- `rename <name>` sets the session title at the next prompt. Renaming the session with Claude Code\'s own `/rename` works the same way.',
    ...ext.map((e) => `- \`${e.args}\` (${e.module}): ${e.summary}`),
    '',
    'When the user describes the session\'s job in plain language, pick a short kebab-case name' +
      (ext.length ? ` (and ${ext.map((e) => e.args).join(', ')} where it fits)` : '') +
      ' from their words. Say which you chose, and run this command; do not ask them to run it.',
    '',
    `<!-- ${CORTEX_MARKER}:core -->`,
    '',
  ].join('\n')
  const now = await fs.readFile(target, 'utf-8').catch(() => null)
  if (now !== body) await fs.writeFile(target, body, 'utf-8')
  return target
}

/** Core's own commands beside status and rename: core/commands/<name>.md becomes /cortex-<name> (statusline, update). */
const coreCommandFiles = async (p: HarnessPaths): Promise<string[]> =>
  (await fs.readdir(path.join(p.repoRoot, 'core', 'commands')).catch(() => [] as string[])).filter((f) => f.endsWith('.md')).map((f) => path.join(p.repoRoot, 'core', 'commands', f))

const installCoreCommands = async (p: HarnessPaths): Promise<void> => {
  for (const file of await coreCommandFiles(p)) {
    const target = path.join(commandsDir(p), `cortex-${path.basename(file, '.md')}.md`)
    const now = await fs.readFile(target, 'utf-8').catch(() => null)
    // A file without our marker is someone else's; one a module wrote (setup's, before 2 Nov) becomes core's.
    if (now !== null && !now.includes(CORTEX_MARKER)) continue
    const body = `${renderCommand(await fs.readFile(file, 'utf-8'), p).trimEnd()}\n\n<!-- ${CORTEX_MARKER}:core -->\n`
    if (now !== body) await fs.writeFile(target, body, 'utf-8')
  }
}

/** Install core's own proof-of-life command (read-only, no arguments), and core's other commands. */
export const installStatusCommand = async (p: HarnessPaths): Promise<string> => {
  const dir = commandsDir(p)
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, 'cortex-status.md')
  const body = [
    '---',
    'description: Show Cortex core status — version, installed modules, and what is missing',
    '---',
    '',
    'Run this command and show the user its output verbatim:',
    '',
    '```bash',
    runScript(p.repoRoot, 'cortex-status.ts'),
    '```',
    '',
    'This is read-only. It takes no arguments and changes nothing.',
    '',
    `<!-- ${CORTEX_MARKER}:core -->`,
    '',
  ].join('\n')
  const now = await fs.readFile(target, 'utf-8').catch(() => null)
  if (now !== body) await fs.writeFile(target, body, 'utf-8')
  await installCoreCommands(p)
  return target
}

/**
 * The status line is ONE slot the user owns, unlike hooks, which are lists we
 * can append to. Three states, kept apart by exact match (a substring match on
 * "cortex-statusline" once read the user's wrapper as ours and replaced it,
 * dropping the user's own line, laptop 2026-10-13):
 *
 *   ours          bash <repo>/bin/cortex-statusline.sh: claim, refresh, remove
 *   wrapped       bash <config>/cortex-statusline-wrap.sh: the user's command
 *                 plus ours (written by /cortex-statusline apply); never
 *                 replaced, and uninstall restores the user's command from it
 *   the user's    anything else: never touched; install prints how to add ours
 *
 * Install also heals the clobbered case: our plain script in the slot while a
 * wrapper file exists means the wrapper was overwritten, so it is put back.
 */
const STATUSLINE_SCRIPT = 'cortex-statusline.sh'
export const WRAPPER = 'cortex-statusline-wrap.sh'

export type StatuslineResult = { installed: boolean; command: string; existing?: string; healed?: boolean }

const wrapperPath = (p: HarnessPaths) => path.join(p.claudeDir, WRAPPER)
const isWrapper = (cmd: string) => cmd.includes(WRAPPER)
const isOurs = (cmd: string) => !isWrapper(cmd) && cmd.includes(STATUSLINE_SCRIPT)

/** The user's original command, as the wrapper recorded it. */
export const wrappedCommand = async (p: HarnessPaths): Promise<string | undefined> => {
  try {
    const m = (await fs.readFile(wrapperPath(p), 'utf-8')).match(/^# Your command, unchanged:\n#   (.*)$/m)
    return m?.[1]?.trim()
  } catch {
    return undefined
  }
}

export const installStatusline = async (p: HarnessPaths): Promise<StatuslineResult> => {
  const file = settingsFile(p)
  const current = await readSettings(file)
  const command = `bash ${path.join(p.repoRoot, 'bin', STATUSLINE_SCRIPT)}`
  const existing = (current.statusLine as { command?: string } | undefined)?.command
  if (existing && isWrapper(existing)) return { installed: false, command, existing }
  if (existing && isOurs(existing) && (await wrappedCommand(p))) {
    await writeSettings(file, { ...current, statusLine: { type: 'command', command: `bash ${wrapperPath(p)}` } })
    return { installed: true, command: `bash ${wrapperPath(p)}`, healed: true }
  }
  if (existing && !isOurs(existing)) return { installed: false, command, existing }
  await writeSettings(file, { ...current, statusLine: { type: 'command', command } })
  return { installed: true, command }
}

export const uninstallStatusline = async (p: HarnessPaths): Promise<boolean> => {
  const file = settingsFile(p)
  const current = await readSettings(file)
  const existing = (current.statusLine as { command?: string } | undefined)?.command
  if (existing && isWrapper(existing)) {
    const original = await wrappedCommand(p)
    if (!original) return false // cannot recover theirs: leave the slot as it is
    await writeSettings(file, { ...current, statusLine: { type: 'command', command: original } })
    await fs.rm(wrapperPath(p), { force: true })
    return true
  }
  if (!existing || !isOurs(existing)) return false
  const { statusLine: _, ...rest } = current
  await writeSettings(file, rest)
  return true
}
