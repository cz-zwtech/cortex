/** UserPromptSubmit: note whether the prompt named an external target, for this turn's Stop audit. */
import type { ModuleCtx } from '../../../core/ctx.js'
import { noteTarget } from './ruleAudit.js'

export default (payload: unknown, ctx: ModuleCtx) => {
  const p = (payload ?? {}) as { session_id?: string; prompt?: string; agent_id?: string }
  if (!p.agent_id) noteTarget(ctx.dataDir, p.session_id, p.prompt ?? '')
  return undefined
}
