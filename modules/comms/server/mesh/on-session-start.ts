/**
 * SessionStart: when this node connects (it listens, or has peers), make sure the daemon runs,
 * without waiting for it. A local-only node starts nothing: its sessions talk through the local
 * log. Headless runs, subagents and test processes do not start daemons; CKN_MESH_AUTOSTART=0
 * turns this off.
 */
import fs from 'node:fs'
import path from 'node:path'

import type { ModuleCtx } from '../../../../core/ctx.js'
import { meshDir, underTest } from '../../../../core/paths.js'
import { connects, migrateConnect } from './connect.js'
import { isRunning, start, startProblem } from './control.js'

/** A start that was needed and did not happen goes in daemon.log: stderr from a hook reaches nobody. */
const note = (dir: string, line: string) => {
  try {
    fs.appendFileSync(path.join(dir, 'daemon.log'), `${new Date().toISOString()} session start: ${line}\n`)
  } catch {
    /* no mesh dir yet: nothing to tell */
  }
}

export default async (payload: unknown, ctx: ModuleCtx, env: NodeJS.ProcessEnv = process.env) => {
  const p = (payload ?? {}) as { agent_id?: string }
  if (p.agent_id || underTest(env)) return undefined
  const sdk = (env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk')
  try {
    const dir = meshDir()
    if (sdk || env.CKN_MESH_AUTOSTART === '0') {
      if (connects(dir) && !isRunning(dir)) note(dir, `daemon not running and not started (${sdk ? `entrypoint ${env.CLAUDE_CODE_ENTRYPOINT}` : 'CKN_MESH_AUTOSTART=0'}); cortex-mesh start`)
      return undefined
    }
    const m = migrateConnect(dir)
    if (m.wrote) ctx.log(`mesh: connect set once from what this node did before: listen ${m.listen ? 'on' : 'off'} (${m.why})`)
    if (!connects(dir)) return undefined
    const result = await start(dir)
    const problem = startProblem(result, dir)
    if (problem) {
      note(dir, problem)
      return { additionalContext: `Cortex mesh: the daemon did not start (${problem}), so messages from other nodes will not arrive. Run cortex-mesh start and report it.` }
    }
    if (result === 'started') return { additionalContext: 'Cortex mesh: the daemon was down; a start was issued. If it stays down, the watcher says so: then run cortex-mesh start and report it.' }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    try {
      note(meshDir(), `failed: ${why}`)
    } catch {
      /* the mesh dir itself is what failed */
    }
    return { additionalContext: `Cortex mesh: the daemon did not start (${why}), so messages from other nodes will not arrive. Run cortex-mesh start and report it.` }
  }
  return undefined
}
