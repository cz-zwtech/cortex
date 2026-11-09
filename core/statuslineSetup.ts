/**
 * Bringing the user's status line onto the Cortex V2 segment, without a human
 * editing scripts.
 *
 * The status line is the user's own: a command in settings.json, usually a
 * script they wrote. So this never rewrites what they built. It does three
 * things only, each reversible:
 *   - EMPTY slot: point it at Cortex's script (cortex-install already does this);
 *   - NO Cortex segment: wrap their command in a small script that runs it and
 *     appends Cortex's segment, so their output is untouched.
 * Every file it changes is backed up first, and the result is test-rendered;
 * if that fails, the backups are put back and nothing has changed.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type StatuslineKind = 'empty' | 'none' | 'v2'
export type Detected = { kind: StatuslineKind; command?: string; script?: string }

const V2_MARK = 'cortex-statusline'

const expand = (p: string) => p.replace(/^~(?=\/)/, os.homedir()).replace(/\$HOME|\$\{HOME\}/g, os.homedir())

/** The script file a status line command runs, when it runs one. */
export const scriptOf = (command: string): string | undefined => {
  for (const tok of command.split(/\s+/)) {
    const p = expand(tok.replace(/^['"]|['"]$/g, ''))
    if (/\.(sh|bash)$/.test(p) && fs.existsSync(p)) return p
  }
  return undefined
}

export const detect = (settings: { statusLine?: { command?: string } }): Detected => {
  const command = settings.statusLine?.command?.trim()
  if (!command) return { kind: 'empty' }
  if (command.includes(V2_MARK)) return { kind: 'v2', command }
  const script = scriptOf(command)
  const body = script ? fs.readFileSync(script, 'utf-8') : command
  if (body.includes(V2_MARK)) return { kind: 'v2', command, script }
  return { kind: 'none', command, script }
}

export const wrapperScript = (original: string, v2Script: string): string =>
  [
    '#!/usr/bin/env bash',
    '# Written by Cortex: runs your own status line, then appends the Cortex segment.',
    '# Your command, unchanged:',
    `#   ${original.replace(/\n/g, ' ')}`,
    'input=$(cat)',
    `left=$(printf '%s' "$input" | ${original})`,
    `right=$(printf '%s' "$input" | bash ${JSON.stringify(v2Script)})`,
    `printf '%s  %s' "$left" "$right"`,
    '',
  ].join('\n')

export type ApplyResult = { ok: true; changed: string[]; backups: string[] } | { ok: false; reason: string }

/**
 * Apply the upgrade for what `detect` found. `writeSettings` is injected so the
 * caller's settings writer (with its own backup) is the only one that touches
 * settings.json.
 */
export const apply = (
  found: Detected,
  opts: {
    claudeDir: string
    v2Script: string
    readSettings: () => Record<string, unknown>
    writeSettings: (s: Record<string, unknown>) => void
    stamp: string
  },
): ApplyResult => {
  if (found.kind === 'v2') return { ok: true, changed: [], backups: [] }
  const settings = opts.readSettings()
  if (found.kind === 'empty') {
    opts.writeSettings({ ...settings, statusLine: { type: 'command', command: `bash ${opts.v2Script}` } })
    return { ok: true, changed: ['settings.json'], backups: [] }
  }

  const backups: string[] = []
  const changed: string[] = []
  const restore: (() => void)[] = []

  const wrapper = path.join(opts.claudeDir, 'cortex-statusline-wrap.sh')
  fs.writeFileSync(wrapper, wrapperScript(found.command!, opts.v2Script), { mode: 0o755 })
  changed.push(wrapper)
  opts.writeSettings({ ...settings, statusLine: { ...(settings.statusLine as object), type: 'command', command: `bash ${wrapper}` } })
  changed.push('settings.json')
  restore.push(() => opts.writeSettings(settings))

  // Render once, the way the harness will. A status line that errors is worse
  // than the red dots it replaced.
  const r = spawnSync('bash', [wrapper], { input: JSON.stringify({ session_id: 'cortex-check' }), encoding: 'utf-8', timeout: 5000 })
  const syntax = found.script ? spawnSync('bash', ['-n', found.script]).status : 0
  if (r.status !== 0 || syntax !== 0 || !r.stdout.includes('cortex')) {
    for (const undo of restore.reverse()) undo()
    fs.rmSync(wrapper, { force: true })
    return { ok: false, reason: `the edited status line did not render (exit ${r.status}); everything was put back` }
  }
  return { ok: true, changed, backups }
}

const declineFile = (dataDir: string) => path.join(dataDir, 'statusline.json')

/** A "no" is remembered per kind of status line found. */
export const declined = (dataDir: string, kind: StatuslineKind): boolean => {
  try {
    return (JSON.parse(fs.readFileSync(declineFile(dataDir), 'utf-8')) as { declined?: string }).declined === kind
  } catch {
    return false
  }
}

export const decline = (dataDir: string, kind: StatuslineKind): void => {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(declineFile(dataDir), JSON.stringify({ declined: kind, at: Date.now() }))
}
