/**
 * SessionStart: start the catch-up over every transcript (sessions that crashed
 * or never reached Stop included), and warn when any transcript could be
 * deleted by Claude Code's cleanup before it is captured.
 */
import type { ModuleCtx } from '../../../core/ctx.js'
import { claudeConfigDir } from '../../../core/paths.js'
import path from 'node:path'
import { WARN_BEFORE_DAYS, captureStatus, cleanupHorizonDays } from './context/capture.js'
import { contextStorePath, spawnCatchUp, spawnScheduleCheck } from './context/hooks.js'
import { ContextStore } from './context/store.js'

export default (payload: unknown, ctx: ModuleCtx) => {
  spawnCatchUp(ctx, 'session-start')
  spawnScheduleCheck(ctx, (payload as { transcript_path?: string } | undefined)?.transcript_path)
  let store: ContextStore | undefined
  try {
    store = new ContextStore(contextStorePath(ctx.dataDir))
    const dir = claudeConfigDir()
    const s = captureStatus(store, path.join(dir, 'projects'), cleanupHorizonDays(dir))
    if (!s.atRisk.length) return undefined
    return {
      additionalContext:
        `Cortex memory: ${s.atRisk.length} session transcript${s.atRisk.length === 1 ? ' is' : 's are'} not yet captured and within ` +
        `days of Claude Code's cleanup (cleanupPeriodDays ${s.horizonDays}). A catch-up is running; check with: cortex-memory capture --status`,
    }
  } catch (err) {
    ctx.log(`capture status skipped: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  } finally {
    store?.close()
  }
}
