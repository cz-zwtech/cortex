/**
 * SessionStart: when this node connects (it listens, or has peers), make sure the daemon runs,
 * without waiting for it. A local-only node starts nothing: its sessions talk through the local
 * log. Headless runs, subagents and test processes do not start daemons; CKN_MESH_AUTOSTART=0
 * turns this off.
 */
import type { ModuleCtx } from '../../../../core/ctx.js'
import { meshDir, underTest } from '../../../../core/paths.js'
import { connects, migrateConnect } from './connect.js'
import { start } from './control.js'

export default async (payload: unknown, ctx: ModuleCtx, env: NodeJS.ProcessEnv = process.env) => {
  const p = (payload ?? {}) as { agent_id?: string }
  if (p.agent_id || (env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk') || underTest(env) || env.CKN_MESH_AUTOSTART === '0') return undefined
  try {
    const dir = meshDir()
    const m = migrateConnect(dir)
    if (m.wrote) ctx.log(`mesh: connect set once from what this node did before: listen ${m.listen ? 'on' : 'off'} (${m.why})`)
    if (connects(dir)) await start(dir)
  } catch (err) {
    ctx.log(`mesh daemon did not start: ${err instanceof Error ? err.message : String(err)}`)
  }
  return undefined
}
