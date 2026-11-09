/**
 * SessionStart: offer the two things a human should not have to remember.
 *
 *   - the status line, when it lacks the Cortex segment;
 *   - an update, when the checkout is behind its remote (mode ask or auto).
 *
 * Both are one line each, asked once: a "no" is recorded by the command the
 * session runs, and the update check itself runs in the background, so this
 * hook never waits on the network. Headless runs and subagents get nothing.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeConfigDir, runScript } from './paths.js'

import { declined, detect } from './statuslineSetup.js'
import { CHECK_EVERY_MS, readPrefs } from './update.js'

const REPO = path.resolve(import.meta.dirname, '..')
const CLI = runScript(REPO, 'cortex-setup.ts')

const settings = (env: NodeJS.ProcessEnv) => {
  const dir = claudeConfigDir(env)
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')) as { statusLine?: { command?: string } }
  } catch {
    return {}
  }
}

export const statuslineLine = (dataDir: string, env: NodeJS.ProcessEnv): string | undefined => {
  const found = detect(settings(env))
  if (found.kind === 'v2' || declined(dataDir, found.kind)) return undefined
  return (
    'Cortex: the status line has no Cortex segment (memory count, bus, mesh, member name). Ask the user once whether to add it; ' +
    'their own status line stays as it is. If yes, run /cortex-statusline apply; if no, run /cortex-statusline decline.'
  )
}

export const updateLine = (dataDir: string): string | undefined => {
  const p = readPrefs(dataDir)
  const mode = p.mode ?? 'ask'
  if (mode === 'off' || !p.last?.behind || p.last.remote === p.skipped) return undefined
  const n = `${p.last.behind} commit${p.last.behind === 1 ? '' : 's'}`
  return mode === 'auto'
    ? `Cortex: an update is available (${n} on ${p.last.branch}). Run /cortex-update now, before other work, and tell the user what changed.`
    : `Cortex: an update is available (${n} on ${p.last.branch}). Ask the user once whether to update now; if yes run /cortex-update, if no run /cortex-update skip.`
}

const refreshInBackground = (dataDir: string) => {
  const p = readPrefs(dataDir)
  if ((p.mode ?? 'ask') === 'off' || (p.last && Date.now() - p.last.checkedAt < CHECK_EVERY_MS)) return
  const child = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-setup.ts'), 'update', 'check'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

/** Core's, since 2 Nov (setup was a module): ctx.dataDir is still <data>/setup, so no data moved. */
export default (payload: unknown, ctx: { dataDir: string }, env: NodeJS.ProcessEnv = process.env) => {
  const p = (payload ?? {}) as { agent_id?: string }
  if (p.agent_id || (env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk')) return undefined
  try {
    refreshInBackground(ctx.dataDir)
  } catch {
    /* a failed check is retried next session */
  }
  const lines = [statuslineLine(ctx.dataDir, env), updateLine(ctx.dataDir)].filter(Boolean)
  return lines.length ? { additionalContext: lines.join('\n') } : undefined
}

export { CLI }
