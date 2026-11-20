/** UserPromptSubmit: what the Stop hooks noticed about the last reply, delivered once. */
import type { ModuleCtx } from '../../../core/ctx.js'
import { injectsInto } from './headless.js'
import { takeReminders } from './pendingReminders.js'

export default (payload: unknown, ctx?: ModuleCtx) => {
  const p = (payload ?? {}) as { session_id?: string; agent_id?: string }
  if (!ctx || p.agent_id || !p.session_id || !injectsInto()) return undefined
  try {
    const pending = takeReminders(ctx.dataDir, p.session_id)
    if (!pending.length) return undefined
    return { additionalContext: `Cortex reminder from your last reply:\n\n${pending.join('\n\n')}` }
  } catch (err) {
    ctx.log(`pending reminders skipped: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}
