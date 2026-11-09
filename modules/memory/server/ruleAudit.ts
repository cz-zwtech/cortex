/**
 * Audit mode (design H3 and section 10, PM .13401): checkable rules run on text
 * that leaves for someone else, and the result is LOGGED, never blocked. A
 * week of this data decides whether any rule becomes remind or deny.
 *
 * Three places text leaves:
 *   - a prose file written (.md, .txt): Write, Edit, MultiEdit;
 *   - an outbound send: cortex-telegram send, cortex-role send/reply, or a
 *     messaging MCP tool (Slack, WhatsApp, mail);
 *   - a chat reply the user will paste (their Slack and WhatsApp drafts arrive this
 *     way, with no tool call): checked at Stop when the turn's prompt named an
 *     external target.
 *
 * Quotes and code are exempt (rules.ts maskExempt). Cheap by design: one regex
 * per checkable rule, inside the dispatcher's 1750 ms per-module budget.
 */
import fs from 'node:fs'
import path from 'node:path'

import { appendFire } from './ruleReview.js'
import { checkText, forOutbound, namedTarget, type Rule, type Violation } from './rules.js'

type ToolPayload = { tool_name?: string; tool_input?: Record<string, unknown>; session_id?: string }

const PROSE = /\.(md|markdown|txt)$/i
const MESSAGING_MCP = /^mcp__.*(slack|whatsapp|gmail|mail|message|telegram)/i

/** The text a tool call is about to send or write for others, and what it is; null when none. */
/**
 * Who reads it. A bus send goes to another session and a Telegram send to
 * the user: both internal by definition, so a text_for:external rule does not
 * apply (an email-style rule should not be reminded on one session's reply to
 * another). A messaging tool reaches people outside. A prose file could be either.
 */
export type Audience = 'internal' | 'external' | 'unknown'

export const outboundText = (p: ToolPayload): { what: string; text: string; audience: Audience } | null => {
  const tool = p.tool_name ?? ''
  const input = p.tool_input ?? {}
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if ((tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') && PROSE.test(str('file_path'))) {
    const edits = Array.isArray(input.edits) ? (input.edits as { new_string?: string }[]).map((e) => e.new_string ?? '').join('\n') : ''
    const text = str('content') || str('new_string') || edits
    return text ? { what: `${tool} ${path.basename(str('file_path'))}`, text, audience: 'unknown' } : null
  }
  if (tool === 'Bash') {
    const cmd = str('command')
    if (!/\bcortex-(telegram\.ts|telegram)\b.*\bsend\b|\bcortex-role(\.ts)?\b.*\b(send|reply)\b/.test(cmd)) return null
    const heredoc = cmd.match(/<<-?\s*'?(\w+)'?\n([\s\S]*?)\n\1\b/)
    return { what: 'outbound send (Bash)', text: heredoc ? heredoc[2]! : cmd.replace(/["']/g, ' '), audience: 'internal' }
  }
  if (MESSAGING_MCP.test(tool)) {
    const text = ['text', 'message', 'body', 'content'].map(str).find(Boolean)
    return text ? { what: `outbound send (${tool})`, text, audience: 'external' } : null
  }
  return null
}

/** Run every checkable outbound rule on the text and log one fire per rule. Returns the finding count. */
export const audit = (text: string, rules: Rule[], log: string, at: { session?: string; event: string; what: string; audience?: Audience }, now = Date.now()): number => {
  let total = 0
  for (const r of forAudience(forOutbound(rules), at.audience).filter((x) => x.check.startsWith('regex:') && x.enforce !== 'none')) {
    const n = checkText(text, [r]).length
    total += n
    appendFire(log, { at: now, rule: r.name, ...(at.session ? { session: at.session } : {}), event: at.event, what: at.what, findings: n, outcome: n ? 'audited-violation' : 'audited-clean' })
  }
  return total
}

// ── the chat-reply audit at Stop ─────────────────────────────────────────────

const targetFile = (dir: string, session: string) => path.join(dir, 'targets', `${session.replace(/[^\w-]/g, '_')}.json`)

/** At each prompt: remember whether it named an external target, for this turn's Stop. */
export const noteTarget = (dir: string, session: string | undefined, prompt: string): string | undefined => {
  if (!session) return undefined
  const target = namedTarget(prompt)
  const f = targetFile(dir, session)
  try {
    if (target) {
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, JSON.stringify({ target, at: Date.now() }))
    } else fs.rmSync(f, { force: true })
  } catch {
    /* measurement only */
  }
  return target
}

export const takeTarget = (dir: string, session: string | undefined): string | undefined => {
  if (!session) return undefined
  const f = targetFile(dir, session)
  try {
    const t = (JSON.parse(fs.readFileSync(f, 'utf-8')) as { target: string }).target
    fs.rmSync(f, { force: true })
    return t
  } catch {
    return undefined
  }
}

/**
 * The text of the turn's last assistant message, from the transcript's tail.
 * Read from the end and bounded, so a long session costs the same as a short
 * one.
 */
export const lastReply = (transcript: string, maxBytes = 512_000): string => {
  let tail = ''
  try {
    const st = fs.statSync(transcript)
    const len = Math.min(st.size, maxBytes)
    const fd = fs.openSync(transcript, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, st.size - len)
    fs.closeSync(fd)
    tail = buf.toString('utf-8')
  } catch {
    return ''
  }
  const lines = tail.split('\n').reverse()
  for (const l of lines) {
    if (!l.includes('"assistant"')) continue
    try {
      const rec = JSON.parse(l) as { type?: string; message?: { content?: { type: string; text?: string }[] } }
      if (rec.type !== 'assistant') continue
      const text = (rec.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
      if (text.trim()) return text
    } catch {
      /* a torn line */
    }
  }
  return ''
}

// ── acting on outbound text: deny, remind, and the rules no regex can check ──
//
// Audit mode logged and never blocked, and that was the design until a week of
// data said which rules matter (a few rules held nearly every
// violation). A rule's enforce now does what it says on
// outbound text: deny refuses the write or send (or bounces a reply for an
// external target once) quoting the matched lines; remind on a regex rule
// shows the matches before the text goes; a text_for rule with a manual check,
// which no regex can audit, is reminded at the write or send, once per stretch.

export type OutboundVerdict = {
  /** Deny rules the text breaks, with what matched. Empty: nothing is refused. */
  denied: { rule: Rule; found: Violation[] }[]
  /** Lines to put in front of the call. */
  reminders: string[]
}

const said = (r: Rule) => `${r.do || r.name}${r.why ? `. Why: ${r.why}` : ''}`
const where = (v: Violation[]) => v.slice(0, 5).map((x) => `line ${x.line}, col ${x.col}: ${x.excerpt}`).join('; ')

/** What outbound text should meet, by each applicable rule's enforce. `manualDue` says whether a manual rule is due a reminder. */
/** Rules that apply to text for this audience: internal text drops text_for rules that do not name internal or all. */
export const forAudience = (rules: Rule[], audience: Audience = 'unknown'): Rule[] =>
  audience !== 'internal'
    ? rules
    : rules.filter((r) => !r.when.startsWith('text_for:') || r.when.slice(9).split(',').map((t) => t.trim()).some((t) => t === 'internal' || t === 'all'))

export const judgeOutbound = (text: string, rules: Rule[], manualDue: (r: Rule) => boolean = () => true, audience: Audience = 'unknown'): OutboundVerdict => {
  const out: OutboundVerdict = { denied: [], reminders: [] }
  for (const r of forAudience(forOutbound(rules), audience).filter((x) => x.enforce !== 'none')) {
    if (r.check.startsWith('regex:')) {
      const found = checkText(text, [r])
      if (!found.length) continue
      if (r.enforce === 'deny') out.denied.push({ rule: r, found })
      else if (r.enforce === 'remind') out.reminders.push(`- ${said(r)}. Matched: ${where(found)}`)
    } else if (r.when.startsWith('text_for:') && manualDue(r)) {
      out.reminders.push(`- ${said(r)}`)
    }
  }
  return out
}

export const deniedReason = (denied: OutboundVerdict['denied'], what: string): string =>
  `Cortex refused ${what}: it breaks ${denied.length === 1 ? 'a rule' : `${denied.length} rules`}.\n` +
  denied.map((d) => `- ${d.rule.name}: ${said(d.rule)}\n  ${where(d.found)}`).join('\n') +
  '\nRewrite those lines and try again. Quotes and code are exempt. If the user wants it as is, they run in their own terminal: ' +
  denied.map((d) => `cortex-rules allow ${d.rule.name} --once`).join(' / ')

const remindedFile = (dir: string, session: string) => path.join(dir, 'rules-reminded', `${session.replace(/[^\w-]/g, '_')}.json`)

/** A manual-check rule is reminded once per this stretch of a session. */
export const MANUAL_REPEAT_MS = 10 * 60 * 1000

export const manualDueIn = (dir: string, session: string | undefined, now = Date.now()) => {
  let seen: Record<string, number> = {}
  if (session)
    try {
      seen = JSON.parse(fs.readFileSync(remindedFile(dir, session), 'utf-8')) as Record<string, number>
    } catch {
      /* first of the session */
    }
  const due = new Set<string>()
  return {
    due: (r: Rule) => {
      const ok = !session || now - (seen[r.name] ?? 0) >= MANUAL_REPEAT_MS
      if (ok) due.add(r.name)
      return ok
    },
    save: () => {
      if (!session || !due.size) return
      for (const n of due) seen[n] = now
      try {
        fs.mkdirSync(path.dirname(remindedFile(dir, session)), { recursive: true })
        fs.writeFileSync(remindedFile(dir, session), JSON.stringify(seen))
      } catch {
        /* reminding twice is the cost */
      }
    },
  }
}
