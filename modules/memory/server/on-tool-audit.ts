import path from 'node:path'

import type { ModuleCtx } from '../../../core/ctx.js'
import { audit, deniedReason, judgeOutbound, manualDueIn, outboundText } from './ruleAudit.js'
import { takeOverride } from './ruleOverrides.js'
import { appendFire } from './ruleReview.js'
import type { Rule } from './rules.js'

/**
 * PreToolUse — rules for text that leaves for someone else (a prose write, a
 * send): every check logged (audit), and each rule's enforce acted on
 * (ruleAudit.ts judgeOutbound): deny refuses the call, remind shows the
 * matches or, for a rule no regex can check, the rule itself.
 */
export default (payload: unknown, ctx: ModuleCtx) => {
  try {
    const p = (payload ?? {}) as { tool_name?: string; tool_input?: Record<string, unknown>; session_id?: string }
    const out = outboundText(p)
    const rules = out && ctx.capabilities.get<{ list: () => Rule[] }>('memory.rules')?.list()
    if (!out || !rules?.length) return undefined
    const fires = path.join(ctx.dataDir, 'rule-fires.jsonl')
    audit(out.text, rules, fires, { session: p.session_id, event: 'PreToolUse', what: out.what, audience: out.audience })

    const manual = manualDueIn(ctx.dataDir, p.session_id)
    const v = judgeOutbound(out.text, rules, manual.due, out.audience)
    manual.save()
    const now = Date.now()
    const denied = v.denied.filter((d) => {
      if (!takeOverride(ctx.dataDir, d.rule.name, now)) return true
      appendFire(fires, { at: now, rule: d.rule.name, ...(p.session_id ? { session: p.session_id } : {}), event: 'PreToolUse', what: out.what, findings: d.found.length, outcome: 'overridden' })
      return false
    })
    for (const d of denied)
      appendFire(fires, { at: now, rule: d.rule.name, ...(p.session_id ? { session: p.session_id } : {}), event: 'PreToolUse', what: out.what, findings: d.found.length, outcome: 'denied' })
    if (denied.length) return { decision: 'deny' as const, reason: deniedReason(denied, out.what) }
    return v.reminders.length ? { additionalContext: `## Cortex — rules for what this ${out.what} sends or writes\n\n${v.reminders.join('\n')}` } : undefined
  } catch (err) {
    ctx.log(`rule audit skipped: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}
