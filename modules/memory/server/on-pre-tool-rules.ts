/**
 * PreToolUse — standing rules scoped to a tool, a path or keywords, at the call
 * they are about (ruleTriggers.ts).
 *
 *   remind  the rule, its why and its source go in front of the call
 *   audit   the call is logged against the rule's check; nothing is said
 *   deny    the call is refused, quoting the rule and its why, unless the user has
 *           overridden it (ruleOverrides.ts: cortex-rules allow, terminal only)
 *
 * Every outcome is a line in rule-fires.jsonl, which cortex-rules review reads.
 * A rule that cannot be evaluated never blocks: a failure here allows the call.
 */

import path from 'node:path'

import type { ModuleCtx } from '../../../core/ctx.js'
import { outgoing } from './on-pre-tool-constraints.js'
import { appendFire } from './ruleReview.js'
import { takeOverride } from './ruleOverrides.js'
import { checkText, type Rule } from './rules.js'
import { firesOn, inScope, repoOf, type Call } from './ruleTriggers.js'

type Payload = { tool_name?: string; tool_input?: Record<string, unknown>; session_id?: string; cwd?: string; agent_id?: string }

const callOf = (p: Payload, roles: string[] | undefined): Call => {
  const input = p.tool_input ?? {}
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const repo = repoOf(p.cwd)
  return {
    tool: p.tool_name ?? '',
    // A search's path (Grep, Glob) is a folder looked through, not a file touched.
    paths: ['file_path', 'notebook_path'].map(str).filter(Boolean),
    ...(p.cwd ? { cwd: p.cwd } : {}),
    // What goes out, never the command line: flags and file names are not the subject.
    text: outgoing(p) ?? '',
    ...(repo ? { repo } : {}),
    ...(roles ? { roles } : {}),
  }
}

type Roles = (session: string) => Promise<{ bound: boolean; roles?: string[] }>

/** The session's comms roles, or undefined when comms cannot say quickly. */
const rolesOf = async (ctx: ModuleCtx, session: string | undefined): Promise<string[] | undefined> => {
  const ask = ctx.capabilities.get<Roles>('comms.sessionRoles')
  if (!ask || !session) return undefined
  try {
    const w = await Promise.race([ask(session), new Promise<undefined>((r) => setTimeout(() => r(undefined), 300))])
    return w?.bound ? w.roles : undefined
  } catch {
    return undefined
  }
}

const said = (r: Rule) => `${r.do || r.name}${r.why ? `. Why: ${r.why}` : ''}${r.source.length ? ` (from ${r.source.map((s) => `[[${s}]]`).join(', ')})` : ''}`

export default async (payload: unknown, ctx?: ModuleCtx) => {
  if (!ctx) return undefined
  const p = (payload ?? {}) as Payload
  try {
    const rules = ctx.capabilities.get<{ list: () => Rule[] }>('memory.rules')?.list() ?? []
    const scoped = rules.filter((r) => r.enforce !== 'none' && /^(tool|path|cwd|keywords):/.test(r.when.trim()))
    if (!scoped.length || !p.tool_name) return undefined
    const roles = scoped.some((r) => r.scope.startsWith('role:')) ? await rolesOf(ctx, p.session_id) : undefined
    const call = callOf(p, roles)
    const fires = path.join(ctx.dataDir, 'rule-fires.jsonl')
    const at = Date.now()
    const log = (r: Rule, outcome: 'reminded' | 'denied' | 'overridden' | 'audited-clean' | 'audited-violation', findings = 0) =>
      appendFire(fires, { at, rule: r.name, ...(p.session_id ? { session: p.session_id } : {}), event: 'PreToolUse', what: call.tool, findings, outcome })

    const reminders: string[] = []
    for (const r of scoped.filter((x) => inScope(x, call) && firesOn(x, call))) {
      if (r.enforce === 'deny') {
        if (takeOverride(ctx.dataDir, r.name, at)) {
          log(r, 'overridden')
          reminders.push(`- ${said(r)} (overridden by the user for this call)`)
          continue
        }
        log(r, 'denied')
        return {
          decision: 'deny' as const,
          reason:
            `Cortex rule ${r.name}: ${said(r)}\n` +
            `This call is refused by that rule. If the user wants it anyway, they run in their own terminal: cortex-rules allow ${r.name} --once`,
        }
      }
      if (r.enforce === 'audit') {
        const n = r.check.startsWith('regex:') ? checkText(call.text, [r]).length : 0
        log(r, n ? 'audited-violation' : 'audited-clean', n)
        continue
      }
      log(r, 'reminded')
      reminders.push(`- ${said(r)}`)
    }
    return reminders.length ? { additionalContext: `## Cortex — rules for this ${call.tool} call\n\n${reminders.join('\n')}` } : undefined
  } catch (err) {
    ctx.log(`rule triggers skipped (call allowed): ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}
