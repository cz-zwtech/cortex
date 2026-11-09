import path from 'node:path'

import type { ModuleCtx } from '../../../core/ctx.js'
import { appendFire } from './ruleReview.js'
import { audit, deniedReason, judgeOutbound, lastReply, takeTarget } from './ruleAudit.js'
import type { Rule } from './rules.js'

/**
 * Stop: a reply the user will paste (the turn's prompt named an external target):
 * logged against the rules, and sent back once when it breaks a deny rule.
 * stop_hook_active marks the rewrite, which passes.
 */
export default (payload: unknown, ctx: ModuleCtx) => {
  try {
    const p = (payload ?? {}) as { session_id?: string; transcript_path?: string; last_assistant_message?: string; agent_id?: string; stop_hook_active?: boolean }
    if (p.agent_id) return undefined
    const target = takeTarget(ctx.dataDir, p.session_id)
    if (!target) return undefined
    const text = p.last_assistant_message ?? (p.transcript_path ? lastReply(p.transcript_path) : '')
    const rules = ctx.capabilities.get<{ list: () => Rule[] }>('memory.rules')?.list()
    if (!text || !rules?.length) return undefined
    const fires = path.join(ctx.dataDir, 'rule-fires.jsonl')
    const what = `chat reply for ${target}`
    audit(text, rules, fires, { session: p.session_id, event: 'Stop', what })
    if (p.stop_hook_active) return undefined
    const { denied } = judgeOutbound(text, rules, () => false)
    if (!denied.length) return undefined
    for (const d of denied) appendFire(fires, { at: Date.now(), rule: d.rule.name, ...(p.session_id ? { session: p.session_id } : {}), event: 'Stop', what, findings: d.found.length, outcome: 'denied' })
    return { decision: 'deny' as const, reason: deniedReason(denied, `this ${what}`) }
  } catch (err) {
    ctx.log(`rule audit skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
  return undefined
}
