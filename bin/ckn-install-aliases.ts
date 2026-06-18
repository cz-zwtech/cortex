#!/usr/bin/env tsx
/**
 * ckn-install-aliases — adds Cortex helper functions (`ckn-start`,
 * `ckn-stop`, `ckn-log`, `ckn-status`, `ckn-mind-sync`, and the client
 * CLIs `ckn-bus`, `ckn-recall`, `ckn-sync`) to the user's shell rc file
 * so they're callable from any terminal (plus `ckn-codegraph` to build a
 * repo's AST graph and `ckn-blast` to query its blast radius). Idempotent —
 * re-running just refreshes the block in place. The client CLIs invoke the
 * repo's own tsx+bin PROJECT_ROOT-relative, so they work for any user
 * pointing at a shared clone.
 *
 * Detects shell from $SHELL, falls back to bash. Uses the current
 * PROJECT_ROOT so it works regardless of where Cortex was cloned.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

const MARKER_BEGIN = '# ── Cortex helpers (managed by ckn-install-aliases) ──'
const MARKER_END = '# ── /Cortex helpers ──'

const detectRc = (): string => {
  const shell = (process.env.SHELL ?? '').toLowerCase()
  const home = os.homedir()
  if (shell.includes('zsh')) return path.join(home, '.zshrc')
  if (shell.includes('fish')) return path.join(home, '.config', 'fish', 'config.fish')
  return path.join(home, '.bashrc')
}

export const buildBlock = (rcPath: string, autostart: boolean): string => {
  const isFish = rcPath.endsWith('config.fish')
  const projectRoot = PROJECT_ROOT
  const logDir = '$HOME/.local/state/ckn'
  if (isFish) {
    return [
      MARKER_BEGIN,
      // Load documented Cortex env (CKN_MESH_TOKEN_CMD, CKN_PROFILE) BEFORE the
      // autostart below, so a launched ckn-start inherits it. fish can't source a
      // bash .env, so parse KEY=VALUE lines and export globally (surrounding quotes
      // trimmed — values like CKN_MESH_TOKEN_CMD contain spaces and are quoted).
      `if test -r "$HOME/.claude/.env"; for __l in (grep -vE '^[[:space:]]*(#|$)' "$HOME/.claude/.env"); set -l __kv (string split -m1 = -- $__l); set -gx $__kv[1] (string trim -c '"' -- $__kv[2]); end; end`,
      `function ckn-start; if ss -tln 2>/dev/null | grep -qE ":(3001|1420)\\b"; echo "ckn: already running"; return 0; end; mkdir -p ${logDir}; cd ${projectRoot}; nohup sh -c 'if command -v bao-run >/dev/null 2>&1 && [ -f "$HOME/.config/ckn/mesh.json" ] && timeout 5 bao-run CKN_MESH_TOKEN -- true >/dev/null 2>&1; then exec bao-run CKN_MESH_TOKEN -- npm start; else exec npm start; fi' > ${logDir}/server.log 2>&1 &; disown; echo "started — log: ${logDir}/server.log (mesh if reachable, else local-only)"; end`,
      // Stop by listening PID (port-derived) — robust to launch method (npm
      // start runs `tsx server/index.ts`, not `tsx watch`, and the real :3001
      // listener's argv contains neither "watch" nor ".bin/tsx"). SIGTERM lets
      // the server shut down cleanly; killing the listeners cascades the
      // concurrently/npm wrappers shut.
      `function ckn-stop; set -l pids (ss -tlnp 2>/dev/null | grep -E ":(3001|1420)\\b" | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u); if test -n "$pids"; kill $pids 2>/dev/null; echo "stopped"; else; echo "not running"; end; end`,
      `function ckn-log; tail -f ${logDir}/server.log; end`,
      `function ckn-status; ss -tlnp 2>/dev/null | grep -E ":(3001|1420)\\b"; or echo "not running"; end`,
      `function ckn-mind-sync; cd ${projectRoot}; and npx tsx bin/ckn-mind-sync.ts $argv; end`,
      // Mesh config CLI: ckn-mesh set/show/clear writes ~/.config/ckn/mesh.json —
      // the peer set ckn-start gates its bao-wrap on. Driver nodes need it to join.
      `function ckn-mesh; cd ${projectRoot}; and ./node_modules/.bin/tsx bin/ckn-mesh.ts $argv; end`,
      // Client CLIs the docs reference (ckn-bus send/watch/peers, etc.). Invoke via
      // the repo's own tsx+bin, PROJECT_ROOT-relative, so they work for ANY user
      // pointing at a shared clone (e.g. /home/claude/cortex with an r-x ACL).
      `function ckn-bus; cd ${projectRoot}; and ./node_modules/.bin/tsx bin/ckn-bus.ts $argv; end`,
      `function ckn-recall; cd ${projectRoot}; and ./node_modules/.bin/tsx bin/ckn-recall.ts $argv; end`,
      `function ckn-sync; cd ${projectRoot}; and ./node_modules/.bin/tsx bin/ckn-sync.ts $argv; end`,
      // Build/refresh a repo's AST code-graph: ckn-codegraph <path> (defaults to cwd).
      `function ckn-codegraph; cd ${projectRoot}; and ./node_modules/.bin/tsx bin/ckn-codegraph.ts $argv; end`,
      // Blast-radius query: ckn-blast <path> [symbol] (auto-refreshes a stale graph).
      `function ckn-blast; cd ${projectRoot}; and ./node_modules/.bin/tsx bin/ckn-blast.ts $argv; end`,
      // Graph branch-diff: ckn-graph-diff <repo|path> <branchA> <branchB> (competing changes first).
      `function ckn-graph-diff; cd ${projectRoot}; and ./node_modules/.bin/tsx bin/ckn-graph-diff.ts $argv; end`,
      // Opt-in statusline dots installer: ckn-statusline [--dots bus,mesh] [--yes].
      `function ckn-statusline; cd ${projectRoot}; and ./node_modules/.bin/tsx bin/ckn-statusline.ts $argv; end`,
      // Opt-in autostart: launch Cortex when an interactive shell opens. Safe to
      // run from every terminal — ckn-start no-ops if it's already up (port
      // guard), so the first shell after a reboot starts it and the rest don't
      // double-launch.
      ...(autostart ? [`status is-interactive; and ckn-start >/dev/null 2>&1`] : []),
      MARKER_END,
      '',
    ].join('\n')
  }
  // bash / zsh — same syntax for this trivial use
  return [
    MARKER_BEGIN,
    `# Source: ${projectRoot}/bin/ckn-install-aliases.ts`,
    // Load documented Cortex env (CKN_MESH_TOKEN_CMD, CKN_PROFILE) BEFORE the
    // function defs + autostart, so a launched ckn-start (and the server it
    // spawns) inherits it — the runtime mesh auto-rejoin reads CKN_MESH_TOKEN_CMD
    // from its own env. Guarded on a readable file; set -a auto-exports; +a is
    // always restored so the rest of the rc isn't left in auto-export mode.
    `if [ -r "$HOME/.claude/.env" ]; then set -a; . "$HOME/.claude/.env"; set +a; fi`,
    `ckn-start() {`,
    `  if ss -tln 2>/dev/null | grep -qE ":(3001|1420)\\b"; then`,
    `    echo "ckn: already running"`,
    `    return 0`,
    `  fi`,
    `  mkdir -p ${logDir}`,
    // Launch via a backgrounded POSIX sh that picks the mode ITSELF: bao-wrap
    // (mesh on) only when bao-run + a mesh.json exist AND CKN_MESH_TOKEN is
    // actually fetchable (a 5s-bounded probe); otherwise a plain start
    // (local-only). So an unreachable OpenBao (laptop off-VPN, NAT node)
    // degrades to local-only instead of FAILING to start. The probe runs inside
    // the background subshell, so this function still returns immediately.
    `  ( cd ${projectRoot} && nohup sh -c 'if command -v bao-run >/dev/null 2>&1 && [ -f "$HOME/.config/ckn/mesh.json" ] && timeout 5 bao-run CKN_MESH_TOKEN -- true >/dev/null 2>&1; then exec bao-run CKN_MESH_TOKEN -- npm start; else exec npm start; fi' > ${logDir}/server.log 2>&1 & disown )`,
    `  echo "started — log: ${logDir}/server.log (mesh if OpenBao+peers reachable, else local-only)"`,
    `}`,
    // Stop by listening PID (port-derived) — robust to launch method (npm
    // start runs `tsx server/index.ts`, not `tsx watch`, and the real :3001
    // listener's argv contains neither "watch" nor ".bin/tsx"). SIGTERM lets
    // the server shut down cleanly; killing the listeners cascades the
    // concurrently/npm wrappers shut.
    `ckn-stop() {`,
    `  local pids`,
    `  pids=$(ss -tlnp 2>/dev/null | grep -E ":(3001|1420)\\b" | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u)`,
    `  if [ -n "$pids" ]; then kill $pids 2>/dev/null; echo "stopped"; else echo "not running"; fi`,
    `}`,
    `ckn-log()    { tail -f ${logDir}/server.log; }`,
    `ckn-status() { ss -tlnp 2>/dev/null | grep -E ":(3001|1420)\\b" || echo "not running"; }`,
    `ckn-mind-sync() { ( cd ${projectRoot} && npx tsx bin/ckn-mind-sync.ts "$@" ); }`,
    // Mesh config CLI: ckn-mesh set/show/clear writes ~/.config/ckn/mesh.json —
    // the peer set ckn-start gates its bao-wrap on. Driver nodes need it to join.
    `ckn-mesh()   { ( cd ${projectRoot} && ./node_modules/.bin/tsx bin/ckn-mesh.ts "$@" ); }`,
    // Client CLIs the docs reference (ckn-bus send/watch/peers, etc.). Invoke via
    // the repo's own tsx+bin, PROJECT_ROOT-relative, so they work for ANY user
    // pointing at a shared clone (e.g. /home/claude/cortex with an r-x ACL).
    `ckn-bus()    { ( cd ${projectRoot} && ./node_modules/.bin/tsx bin/ckn-bus.ts "$@" ); }`,
    `ckn-recall() { ( cd ${projectRoot} && ./node_modules/.bin/tsx bin/ckn-recall.ts "$@" ); }`,
    `ckn-sync()   { ( cd ${projectRoot} && ./node_modules/.bin/tsx bin/ckn-sync.ts "$@" ); }`,
    // Build/refresh a repo's AST code-graph: ckn-codegraph <path> (defaults to cwd).
    `ckn-codegraph() { ( cd ${projectRoot} && ./node_modules/.bin/tsx bin/ckn-codegraph.ts "$@" ); }`,
    // Blast-radius query: ckn-blast <path> [symbol] (auto-refreshes a stale graph).
    `ckn-blast() { ( cd ${projectRoot} && ./node_modules/.bin/tsx bin/ckn-blast.ts "$@" ); }`,
    // Graph branch-diff: ckn-graph-diff <repo|path> <branchA> <branchB> (competing changes first).
    `ckn-graph-diff() { ( cd ${projectRoot} && ./node_modules/.bin/tsx bin/ckn-graph-diff.ts "$@" ); }`,
    // Opt-in statusline dots installer: ckn-statusline [--dots bus,mesh] [--yes].
    `ckn-statusline() { ( cd ${projectRoot} && ./node_modules/.bin/tsx bin/ckn-statusline.ts "$@" ); }`,
    // Opt-in autostart: launch Cortex when an interactive shell opens. Safe to
    // run from every terminal — ckn-start no-ops if it's already up (port
    // guard), so the first shell after a reboot starts it and the rest don't
    // double-launch.
    ...(autostart ? [`[[ $- == *i* ]] && ckn-start >/dev/null 2>&1`] : []),
    MARKER_END,
    '',
  ].join('\n')
}

/**
 * Upsert a single `KEY="value"` line into .env-style content. The value is always
 * double-quoted — values like CKN_MESH_TOKEN_CMD contain spaces, which an unquoted
 * `set -a; . .env` mis-parses. Idempotent (re-applying the same value is a no-op),
 * updates in place when the key already exists, never duplicates, preserves all
 * other lines. Keys are env-var names (word chars), so they need no regex escape.
 */
export const upsertEnvLine = (existing: string, key: string, value: string): string => {
  const line = `${key}="${value}"`
  const re = new RegExp(`^${key}=.*$`, 'm')
  if (re.test(existing)) return existing.replace(re, line)
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
  return `${existing}${sep}${line}\n`
}

/**
 * A fully-commented, secret-manager-AGNOSTIC `~/.claude/.env` scaffold. The public
 * installer writes this only when no .env exists yet: it documents the env the shell
 * helpers source but activates NOTHING — no live infra command baked into a public
 * default. Users uncomment + set values for their own secret manager; a fleet passes
 * an active value via `--mesh-token-cmd` instead.
 */
export const envTemplate = (): string =>
  [
    '# Cortex driver-node env — sourced by the shell helpers, so ckn-start (and the',
    '# server it launches) inherit these. chmod 600. Quote any value with spaces.',
    '#',
    '# Runtime mesh-token fetch — enables hands-free off-VPN -> on-VPN auto-rejoin.',
    '# A command that PRINTS the token to stdout; the token is never stored at rest.',
    '# CKN_MESH_TOKEN_CMD="secret-run CKN_MESH_TOKEN -- printenv CKN_MESH_TOKEN"',
    '#',
    '# Surface your personality profile at session start (opt-in, default off):',
    '# CKN_PROFILE=1',
    '',
  ].join('\n')

/**
 * Wire `~/.claude/.env` (which the shell block now sources). With `--mesh-token-cmd`,
 * upsert an active QUOTED CKN_MESH_TOKEN_CMD; otherwise scaffold the commented agnostic
 * template ONLY when no .env exists yet (never clobber an existing file).
 */
const ensureEnvFile = async (meshTokenCmd?: string): Promise<void> => {
  const envPath = path.join(os.homedir(), '.claude', '.env')
  if (meshTokenCmd) {
    let cur = ''
    try {
      cur = await fs.readFile(envPath, 'utf-8')
    } catch {
      // .env doesn't exist yet — we'll create it.
    }
    const next = upsertEnvLine(cur, 'CKN_MESH_TOKEN_CMD', meshTokenCmd)
    if (next === cur) {
      console.log(`[ckn-install-aliases] CKN_MESH_TOKEN_CMD already set in ${envPath}`)
      return
    }
    await fs.mkdir(path.dirname(envPath), { recursive: true })
    await fs.writeFile(envPath, next, 'utf-8')
    await fs.chmod(envPath, 0o600).catch(() => {})
    console.log(`[ckn-install-aliases] wired CKN_MESH_TOKEN_CMD into ${envPath} (chmod 600)`)
    return
  }
  // No flag: scaffold a commented template only if the file is absent.
  try {
    await fs.access(envPath)
    return // exists — leave it untouched
  } catch {
    await fs.mkdir(path.dirname(envPath), { recursive: true })
    await fs.writeFile(envPath, envTemplate(), 'utf-8')
    await fs.chmod(envPath, 0o600).catch(() => {})
    console.log(`[ckn-install-aliases] scaffolded a commented ${envPath} (no active values; chmod 600)`)
  }
}

/**
 * Returns rc contents with the existing Cortex block (if any) removed.
 * Tolerant of either marker missing — defensive against hand-edits.
 */
const stripExistingBlock = (rc: string): string => {
  const beginIdx = rc.indexOf(MARKER_BEGIN)
  if (beginIdx < 0) return rc
  const endMarkerIdx = rc.indexOf(MARKER_END, beginIdx)
  if (endMarkerIdx < 0) {
    // Begin marker exists but no end — we won't blindly nuke half the
    // file. Leave it; user can clean up manually.
    return rc
  }
  const endIdx = endMarkerIdx + MARKER_END.length
  // Also eat the trailing newline so we don't leave double blank lines.
  const after = rc.slice(endIdx).replace(/^\n/, '')
  const before = rc.slice(0, beginIdx).replace(/\n$/, '')
  return before + (before && after ? '\n' : '') + after
}

const main = async () => {
  const rcPath = detectRc()
  const autostart = process.argv.includes('--autostart')
  const flagIdx = process.argv.indexOf('--mesh-token-cmd')
  const meshTokenCmd = flagIdx >= 0 ? process.argv[flagIdx + 1] : undefined
  // Wire ~/.claude/.env first so it happens even when the rc block is already current.
  await ensureEnvFile(meshTokenCmd)
  const block = buildBlock(rcPath, autostart)

  let existing = ''
  try {
    existing = await fs.readFile(rcPath, 'utf-8')
  } catch {
    // RC doesn't exist — we'll create it.
  }
  const stripped = stripExistingBlock(existing)
  // If the existing block already matches, no-op.
  const targetEnd = (stripped.endsWith('\n') || stripped === '' ? '' : '\n') + block
  if (existing === stripped + (stripped.endsWith('\n') || stripped === '' ? '' : '\n') + block) {
    console.log(`[ckn-install-aliases] already up to date in ${rcPath}`)
    return
  }
  const next = stripped + targetEnd
  await fs.mkdir(path.dirname(rcPath), { recursive: true })
  await fs.writeFile(rcPath, next, 'utf-8')
  console.log(`[ckn-install-aliases] installed Cortex helpers in ${rcPath}`)
  console.log(`[ckn-install-aliases]   PROJECT_ROOT=${PROJECT_ROOT}`)
  console.log(
    `[ckn-install-aliases]   autostart: ${
      autostart
        ? 'ON — Cortex launches when an interactive shell opens (guarded; no double-launch)'
        : 'off — run `ckn-start` yourself, or re-run with --autostart'
    }`,
  )
  console.log(`[ckn-install-aliases] re-source the file or open a new shell:`)
  console.log(`[ckn-install-aliases]   source ${rcPath}`)
  // Opt-in nudge: surface the statusline dots without shipping/forcing one (ship-none).
  console.log(
    `[ckn-install-aliases] optional: run \`ckn-statusline\` to add a bus + mesh dot to your statusline (Cortex ships none by default).`,
  )
}

// Only auto-run when invoked as the entry script (`tsx bin/ckn-install-aliases.ts`),
// NOT when imported (e.g. by the test, which exercises buildBlock) — importing
// must not rewrite the user's rc file.
const isEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) {
  void main().catch((e) => {
    console.error('[ckn-install-aliases] fatal:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
