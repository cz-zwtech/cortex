/**
 * SessionStart, SessionEnd and UserPromptSubmit, in every process (outsideHost): on a node whose
 * private mind is enabled and where no host runs it, start a one-shot `cortex-mind sync`, detached,
 * and return at once. Session start and end always; a prompt when syncEveryMin has passed since
 * the last one began. Central never does: its host serves. Headless runs, subagents and tests do
 * not; CKN_MIND_AUTOSYNC=0 turns it off.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { ModuleCtx } from '../../../core/ctx.js'
import { machineId } from '../../../core/machineId.js'
import { underTest } from '../../../core/paths.js'
import { loadConfig } from './config.js'
import { due, hostRunning, lockHeld, noteStart } from './oneshot.js'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')

export type Spawn = (dataDir: string) => void

const spawnSync_: Spawn = (dataDir) => {
  const out = fs.openSync(path.join(dataDir, 'sync.log'), 'a')
  const child = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'modules', 'private-mind', 'bin', 'cortex-mind.ts'), 'sync'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  })
  child.unref()
}

export const handle = (payload: unknown, ctx: Pick<ModuleCtx, 'dataDir' | 'log'>, env: NodeJS.ProcessEnv = process.env, run: Spawn = spawnSync_): 'started' | undefined => {
  const p = (payload ?? {}) as { agent_id?: string; hook_event_name?: string }
  if (p.agent_id || (env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk') || underTest(env) || env.CKN_MIND_AUTOSYNC === '0') return undefined
  let cfg
  try {
    cfg = loadConfig(ctx.dataDir)
  } catch {
    return undefined // a bad mind.json is reported by status, not by every prompt
  }
  if (!cfg?.enabled || cfg.central === machineId(env)) return undefined
  if (hostRunning(ctx.dataDir) || lockHeld(ctx.dataDir) || !due(ctx.dataDir, p.hook_event_name, cfg.syncEveryMin)) return undefined
  try {
    noteStart(ctx.dataDir)
    run(ctx.dataDir)
    return 'started'
  } catch (err) {
    ctx.log(`private mind: the one-shot sync did not start: ${(err as Error).message}`)
    return undefined
  }
}

export default (payload: unknown, ctx: ModuleCtx) => {
  handle(payload, ctx)
  return undefined
}
