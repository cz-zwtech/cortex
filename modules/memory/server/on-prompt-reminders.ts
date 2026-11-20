/** UserPromptSubmit: what the Stop hooks noticed about the last reply, delivered once. */
import type { ModuleCtx } from '../../../core/ctx.js'
import { takeReminderNote } from '../../../core/pendingReminders.js'
import { injectsInto } from './headless.js'

export default (payload: unknown, ctx?: ModuleCtx) => {
  const p = (payload ?? {}) as { session_id?: string; agent_id?: string }
  if (!ctx || p.agent_id || !p.session_id || !injectsInto()) return undefined
  try {
    const note = takeReminderNote(ctx.dataDir, p.session_id)
    return note ? { additionalContext: note } : undefined
  } catch (err) {
    ctx.log(`pending reminders skipped: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}
