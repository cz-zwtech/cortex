#!/usr/bin/env tsx
/**
 * `install` / `uninstall` — put core's harness surface in place, or take it out.
 *
 * The functions this calls have existed since Phase 2B and nothing called them.
 * That gap is the reason this file exists: a capability with no entry point is
 * indistinguishable from an unbuilt one to the person trying to use it, and the
 * UAT needs a human to run this before there is anything for a session to
 * exercise.
 *
 * WHAT IT WRITES, so nobody has to read the source to find out:
 *   <config>/settings.json   — one hook per lifecycle event, all pointing at
 *                              bin/cortex-hook.ts, marked `cortex:managed`
 *   <config>/commands/*.md   — one file per command contributed by an installed
 *                              module, plus core's own `cortex-status`
 *
 * Everything it writes carries the marker, and uninstall removes exactly what
 * carries it. Nothing else in the file is touched — the settings write is a
 * merge with a backup, never a replace, because this is a file the user owns
 * and shares with the harness.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  installHooks,
  installStatusCommand,
  installRenameCommand,
  syncClaudeImports,
  syncCliShims,
  syncStatusSegments,
  removeClaudeImports,
  installStatusline,
  syncCommands,
  uninstallHooks,
  uninstallStatusCommand,
  uninstallStatusline,
} from '../core/harness.js'
import { backupMemory } from '../core/backup.js'
import { parseManifest } from '../core/manifest.js'
import { unmetRequires } from '../core/resolve.js'
import { checkInstallLocation, humanUsers } from '../core/installLocation.js'
import { dataRoot, modulesDir, claudeConfigDir, meshDir, runScript, stateDir, underTest } from '../core/paths.js'
import { ensureNodeId, hookedSettings, serviceOpts, SERVICE_MODULES } from '../core/serviceInstall.js'
import { exitOnHelp } from '../core/help.js'
import { removedModules } from '../core/modulePrefs.js'

const USAGE = `usage: cortex-install [install|uninstall] [--single-user] [--no-mesh-start]
       [--service [--alias a] [--port n] [--peer host:port] [--role r] [--with m1,m2]]
       [--gateway --domain d [--alias a] [--port n]]
  install (the default) writes Cortex's hooks, commands and status line into the harness config
  and links the shipped modules into the state dir; uninstall removes what carries the marker`
exitOnHelp(USAGE)

const repoRoot = path.resolve(import.meta.dirname, '..')

/**
 * The HARNESS config root — `~/.claude`, or CLAUDE_CONFIG_DIR.
 *
 * Deliberately NOT the Cortex state dir and not the install home. Three
 * different roots that an earlier revision of this project had collapsed into
 * one variable, with the database landing inside a git checkout as a result.
 */
const claudeDir = claudeConfigDir()

const paths = { claudeDir, repoRoot, modulesDir: modulesDir() }
// The mode is the first argument that is neither a flag nor a flag's value: /cortex-update passes --no-mesh-start.
const VALUE_FLAGS = new Set(['--alias', '--port', '--peer', '--role', '--with', '--domain'])
const mode = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && !VALUE_FLAGS.has(all[i - 1] ?? '')) ?? 'install'

if (mode === 'uninstall') {
  await uninstallHooks(paths)
  const { removed } = await syncCommands({ ...paths, modulesDir: path.join(repoRoot, '.none') })
  const statusRemoved = await uninstallStatusCommand(paths)
  await removeClaudeImports(paths)
  await syncCliShims({ ...paths, modulesDir: path.join(repoRoot, '.none') })
  await syncStatusSegments({ ...paths, segmentsDir: path.join(stateDir(), 'statusline.d'), modulesDir: path.join(repoRoot, '.none') })
  const lineRemoved = await uninstallStatusline(paths)
  if (fs.existsSync(path.join(paths.modulesDir, 'comms', 'module.json')) && !underTest()) {
    const { stop } = await import('../modules/comms/server/mesh/control.js')
    await stop(meshDir())
  }
  console.log(`cortex uninstall`)
  console.log(`  settings:  ${path.join(claudeDir, 'settings.json')} — cortex hooks removed`)
  console.log(`  commands:  ${removed.length + (statusRemoved ? 1 : 0)} removed`)
  console.log(`  statusline: ${lineRemoved ? 'removed' : 'not ours, left as is'}`)
  console.log(`\nOnly entries carrying the cortex:managed marker were touched.`)
  process.exit(0)
}

if (mode !== 'install') {
  console.error(USAGE)
  process.exit(2)
}

/**
 * Install the modules that ship with core into the STATE modules directory.
 *
 * The repo's `modules/` is SOURCE. `<state>/modules` is where installed modules
 * live, and it is the only place a running session looks — "drop it in the
 * folder and restart" is the contract, and until something does the dropping,
 * a bundled module is present in the checkout and installed nowhere.
 *
 * This step was missing, and its absence was invisible to me for a specific
 * reason worth recording: I verified with CKN_MODULES_DIR pointed at the repo,
 * so my status showed the module started while a real session — which has no
 * such variable — correctly reported none installed. Both outputs were true
 * about different resolved paths.
 *
 * That is the SAME defect as the CLAUDE_CONFIG_DIR redirect, found one hour
 * apart. I removed the dependency for one variable and left the other doing
 * exactly the same thing, which is what happens when a fix is applied to an
 * instance instead of to the class.
 *
 * Symlinked rather than copied: core and its bundled modules are one artifact
 * and one version, so two copies could drift. A third-party module is a real
 * directory the user drops in, and nothing here touches those.
 */
const installBundledModules = async (only?: string[]): Promise<string[]> => {
  const src = path.join(repoRoot, 'modules')
  const dest = paths.modulesDir
  await fsp.mkdir(dest, { recursive: true })

  const installed: string[] = []
  let names: string[] = []
  try {
    names = (await fsp.readdir(src, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && (!only || only.includes(e.name)))
      .map((e) => e.name)
  } catch {
    return installed
  }
  // What the person took out stays out, unless --with names it.
  if (!only) {
    const removed = removedModules()
    for (const n of names.filter((n) => removed.includes(n))) console.log(`  modules:     ${n} left out: you removed it (cortex-setup module add ${n} brings it back)`)
    names = names.filter((n) => !removed.includes(n))
  }

  // A link into this checkout whose module is gone (mesh, merged into comms on 2 Nov) would load nothing: drop it.
  for (const e of await fsp.readdir(dest, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
    if (!e.isSymbolicLink()) continue
    const target = await fsp.readlink(path.join(dest, e.name)).catch(() => '')
    if (target.startsWith(src + path.sep) && !fs.existsSync(target)) {
      await fsp.unlink(path.join(dest, e.name))
      console.log(`  modules:     removed the link to ${e.name}, which this checkout no longer has`)
    }
  }

  // Refuse before linking anything: every module in the resulting set must have what it requires.
  const already = (await fsp.readdir(dest).catch(() => [] as string[])).filter((n) => !names.includes(n))
  const manifests = [...names.map((n) => path.join(src, n)), ...already.map((n) => path.join(dest, n))].flatMap((dir) => {
    try {
      const r = parseManifest(JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf-8')))
      return r.ok ? [r.manifest] : []
    } catch {
      return []
    }
  })
  const unmet = unmetRequires(manifests)
  if (unmet.length) {
    for (const u of unmet) console.error(`cortex-install: refused, ${u.name} requires ${u.missing.join(', ')}, which ${u.missing.length > 1 ? 'are' : 'is'} not installed and not being installed (add ${u.missing.length > 1 ? 'them' : 'it'} with --with, or leave ${u.name} out)`)
    process.exit(2)
  }

  for (const name of names) {
    const target = path.join(dest, name)
    const from = path.join(src, name)
    if (path.resolve(target) === path.resolve(from)) continue // already the same dir

    try {
      const existing = await fsp.lstat(target).catch(() => null)
      if (existing?.isSymbolicLink()) {
        if ((await fsp.readlink(target)) === from) continue
        await fsp.unlink(target)
      } else if (existing) {
        continue // a real directory the user put there — never overwrite it
      }
      await fsp.symlink(from, target, 'dir')
      installed.push(name)
    } catch {
      /* leave it; status will report what is actually there */
    }
  }
  return installed
}

// On Linux, an install takes multiple users into account (16 Oct 2026).
{
  let passwd = ''
  try {
    passwd = fs.readFileSync('/etc/passwd', 'utf-8')
  } catch {
    /* not Linux, or unreadable: the check passes */
  }
  const where = checkInstallLocation({
    platform: process.platform,
    repoRoot,
    home: os.homedir(),
    // An account runs Cortex if its state holds installed modules or a store; an empty dir (a container
    // volume's mountpoint) does not count, and one this account cannot see reads as not.
    users: humanUsers(passwd).map((u) => ({ ...u, cortex: ['modules', 'cortex.sqlite'].some((f) => fs.existsSync(path.join(u.home, '.config', 'ckn', f))) })),
    singleUser: process.argv.includes('--single-user'),
  })
  if (!where.ok) {
    console.error(`cortex install: refused, ${where.reason}`)
    process.exit(1)
  }
  if (where.note) console.log(`cortex install: ${where.note}`)
}

// Standing rule: a backup of memory and the V2 store before anything changes,
// and no install without one.
let backup
try {
  backup = backupMemory('install', repoRoot)
} catch (err) {
  console.error(`cortex install: refused, ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
// A gateway node (trust doc 1a): mesh and the gateway only, no hooks, no memory, no sessions. Its domain
// key is made here and only its pin is printed, for the owners of peer gateways to pin by hand.
if (process.argv.includes('--gateway')) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
  const domain = arg('--domain')
  const alias = arg('--alias') ?? `${os.hostname().split('.')[0]!.toLowerCase()}-gw`
  const port = Number(arg('--port') ?? 3021)
  if (!domain || !/^[a-z][a-z0-9-]{0,47}$/.test(domain)) {
    console.error('cortex install --gateway: --domain <name> is required: lowercase letters, digits and dashes (e.g. home)')
    process.exit(2)
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`cortex install --gateway: --port must be a port number (got ${arg('--port')})`)
    process.exit(2)
  }
  const hooked = hookedSettings(claudeDir)
  if (hooked) {
    console.error(`cortex install --gateway: refused, ${hooked} has Cortex hooks; a gateway runs no sessions (cortex-install uninstall first)`)
    process.exit(1)
  }
  const linked = await installBundledModules(['comms', 'gateway'])
  const { id, minted } = ensureNodeId(stateDir(), alias)
  const { writeNodeConfig } = await import('../modules/comms/server/mesh/nodeConfig.js')
  writeNodeConfig(meshDir(), { alias, port, host: '0.0.0.0', intent: 'gateway', listen: true })
  const gwDir = path.join(dataRoot(), 'gateway')
  const { ensureDomainKey } = await import('../modules/gateway/server/keys.js')
  const key = ensureDomainKey(gwDir, domain)
  const cfgFile = path.join(gwDir, 'gateway.json')
  if (!fs.existsSync(cfgFile)) fs.writeFileSync(cfgFile, JSON.stringify({ domain, peers: [] }, null, 2) + '\n', { mode: 0o640 })
  console.log('cortex install --gateway')
  console.log(`  backup:      ${backup.file}`)
  console.log(`  modules:     comms (with the mesh), gateway${linked.length ? ` (linked ${linked.join(', ')})` : ' (already linked)'}; no memory, no sessions`)
  console.log(`  hooks:       none (${path.join(claudeDir, 'settings.json')} untouched)`)
  console.log(`  node:        ${id}${minted ? ' (new id)' : ''}, alias ${alias}, internal mesh port ${port}, intent gateway`)
  console.log(`  domain:      ${domain}; key ${key.minted ? 'made' : 'kept'} in ${gwDir} (0600, never printed)`)
  console.log(`  pin:         ${key.pin}`)
  console.log(`  config:      ${cfgFile} (nothing exposed until a role is listed under a peer)`)
  if (!underTest() && !process.argv.includes('--no-mesh-start')) {
    const { start, stop, unitText, UNIT, readStatus } = await import('../modules/comms/server/mesh/control.js')
    const { spawnSync } = await import('node:child_process')
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user')
    fs.mkdirSync(unitDir, { recursive: true })
    fs.writeFileSync(path.join(unitDir, UNIT), unitText())
    await stop(meshDir())
    const sd = (...a: string[]) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf-8' })
    const up = sd('daemon-reload').status === 0 && sd('enable', '--now', UNIT).status === 0
    if (!up) await start(meshDir(), { wait: true })
    for (let i = 0; i < 50 && !readStatus(meshDir())?.running; i++) await new Promise((r) => setTimeout(r, 100))
    const st = readStatus(meshDir())
    console.log(`  daemon:      ${st?.running ? `running on :${st.port}` : 'did not start'}${up ? ` (systemd user unit ${UNIT})` : ' (started directly: systemctl --user was not available)'}`)
  }
  console.log(`\nGive a peer gateway's owner the pin above; add theirs under peers in ${cfgFile}. Status: cortex-gate status`)
  process.exit(0)
}

if (process.argv.includes('--service')) {
  const opts = serviceOpts(process.argv)
  if ('error' in opts) {
    console.error(`cortex install --service: ${opts.error}`)
    process.exit(2)
  }
  const hooked = hookedSettings(claudeDir)
  if (hooked) {
    console.error(`cortex install --service: refused, ${hooked} has Cortex hooks; a service account must have none (cortex-install uninstall first)`)
    process.exit(1)
  }
  const linked = await installBundledModules(opts.modules)
  const { id, minted } = ensureNodeId(stateDir(), opts.alias)
  const { writeNodeConfig } = await import('../modules/comms/server/mesh/nodeConfig.js')
  const { addPeer } = await import('../modules/comms/server/mesh/peers.js')
  writeNodeConfig(meshDir(), { alias: opts.alias, port: opts.port, host: '127.0.0.1', listen: false })
  const peer = addPeer(meshDir(), opts.peer)
  const { spawnSync } = await import('node:child_process')
  // Each module added with --with gets a role of its own name too (telegram -> telegram-1), the
  // address sessions reach it at; core names no module here.
  const roles = [...new Set([opts.role, ...opts.modules.filter((m) => !SERVICE_MODULES.includes(m))])]
  let role: { status: number | null; stdout: string; stderr: string } = { status: 0, stdout: '', stderr: '' }
  for (const r of roles) {
    role = spawnSync(path.join(repoRoot, 'node_modules', '.bin', 'tsx'), [path.join(repoRoot, 'bin', 'cortex-role.ts'), 'join', r, '--create', '--as', `${r}-1`], { encoding: 'utf-8' })
    if (role.status !== 0) break
  }
  console.log('cortex install --service')
  console.log(`  backup:      ${backup.file}`)
  console.log(`  modules:     ${opts.modules.join(', ')}${linked.length ? ` (linked ${linked.join(', ')})` : ' (already linked)'}; no memory`)
  console.log(`  hooks:       none (${path.join(claudeDir, 'settings.json')} untouched)`)
  console.log(`  node:        ${id}${minted ? ' (new id)' : ''}, alias ${opts.alias}, 127.0.0.1:${opts.port}, peer ${peer}`)
  console.log(`  roles:       ${role.status === 0 ? roles.map((r) => `${r} (${r}-1)`).join(', ') : `join failed: ${(role.stderr || role.stdout).trim()}`}`)
  if (!underTest() && !process.argv.includes('--no-mesh-start')) {
    const { start, stop, unitText, UNIT, readStatus } = await import('../modules/comms/server/mesh/control.js')
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user')
    fs.mkdirSync(unitDir, { recursive: true })
    fs.writeFileSync(path.join(unitDir, UNIT), unitText())
    await stop(meshDir())
    const sd = (...a: string[]) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf-8' })
    const up = sd('daemon-reload').status === 0 && sd('enable', '--now', UNIT).status === 0
    if (!up) await start(meshDir(), { wait: true })
    for (let i = 0; i < 50 && !readStatus(meshDir())?.running; i++) await new Promise((r) => setTimeout(r, 100))
    const st = readStatus(meshDir())
    console.log(`  daemon:      ${st?.running ? `running on :${st.port}` : 'did not start'}${up ? ` (systemd user unit ${UNIT})` : ' (started directly: systemctl --user was not available)'}`)
  }
  console.log(`\nSend as the service:  ${runScript(repoRoot, 'cortex-role.ts')} send <node:role> --as ${opts.role}-1 --body-file <file>`)
  process.exit(role.status === 0 ? 0 : 1)
}

const modulesInstalled = await installBundledModules()
const hooks = await installHooks(paths)
const status = await installStatusCommand(paths)
const cmds = await syncCommands(paths)
const rename = await installRenameCommand(paths)
const imports = await syncClaudeImports(paths)
const shims = await syncCliShims(paths)
await syncStatusSegments({ ...paths, segmentsDir: path.join(stateDir(), 'statusline.d') })

console.log('cortex install')
console.log(`  backup:      ${backup.file}`)
console.log(`               restore with: ${backup.restore}`)
console.log(`  config dir:  ${claudeDir}`)
console.log(`  modules dir: ${paths.modulesDir}`)
console.log(
  `  modules:     ${modulesInstalled.length ? modulesInstalled.join(', ') : 'none newly installed'}`,
)
console.log(`  settings:   ${hooks.settingsFile}`)
console.log(`  hooks:      ${hooks.events.length} event(s) — ${hooks.events.join(', ')}`)
console.log(`  commands:   ${[status, ...(rename ? [rename] : []), ...cmds.installed].length} installed`)
console.log(`  on PATH:    ${[...shims.written, ...shims.kept.map((n) => `${n} (not ours, left alone)`)].join(', ') || 'unchanged'}`)
for (const c of [status, ...(rename ? [rename] : []), ...cmds.installed]) console.log(`    ${c}`)
if (cmds.removed.length) console.log(`  removed:    ${cmds.removed.join(', ')}`)
if (imports.files.length) console.log(`  CLAUDE.md:  imports ${imports.files.join(', ')}${imports.changed ? ' (updated; backup CLAUDE.md.before-cortex-imports)' : ''}`)
if (cmds.skipped.length) {
  console.log(`  skipped:    ${cmds.skipped.join(', ')} (exists and is not Cortex's; move it aside and run install again)`)
}
// The mesh: started now so the first session finds its bus, unless under test.
// --no-mesh-start: used by /cortex-update, which leaves a stopped mesh stopped (hub, when Cortex is off).
if (fs.existsSync(path.join(paths.modulesDir, 'comms', 'module.json')) && !underTest() && !process.argv.includes('--no-mesh-start')) {
  const { start, readStatus } = await import('../modules/comms/server/mesh/control.js')
  const { connects, migrateConnect } = await import('../modules/comms/server/mesh/connect.js')
  const m = migrateConnect(meshDir())
  if (m.wrote) console.log(`  connect:     listen ${m.listen ? 'on' : 'off'} (${m.why}); change with cortex-mesh listen on|off`)
  if (!connects(meshDir())) console.log('  mesh:        local-only: no daemon, no open port (cortex-mesh listen on, or cortex-mesh peers add <url>, to connect)')
  else {
    const r = await start(meshDir(), { wait: true })
    const st = readStatus(meshDir())
    console.log(`  mesh:        ${r === 'failed' ? `did not start; see ${path.join(meshDir(), 'daemon.log')}` : `running${st?.port ? ` on :${st.port}` : ''} (cortex-mesh status for peers)`}`)
  }
}
const line = await installStatusline(paths)
if (line.installed) console.log(`  statusline: ${line.command}${line.healed ? ' (your own line restored: a previous install had replaced the wrapper)' : ''}`)
else if (line.existing?.includes('cortex-statusline-wrap.sh')) console.log('  statusline: yours, with the Cortex segment appended (kept)')
else if (!line.existing?.includes('cortex-statusline-wrap.sh')) {
  console.log(`  statusline: yours is kept (${line.existing})`)
  console.log(`              to add the Cortex segment, call this from it with the same stdin:`)
  console.log(`              ${line.command}`)
}

console.log(`
Start a Claude Code session and run /cortex-status to confirm the command is
visible to the harness rather than merely present on disk.`)
