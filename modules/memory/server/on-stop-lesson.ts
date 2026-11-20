/**
 * Stop: a lesson stated is a lesson kept, or the next prompt says so.
 *
 * "Noted, I will not do that again" is a promise the next session cannot see.
 * The principle: every lesson becomes a mechanism fix where one exists,
 * else a rule with the right trigger and strength, and an outright prohibition
 * gets deny. So when a reply states a lesson or a commitment, the turn passes
 * only if this session made it stick in the last half hour: a rule or feedback
 * memory written (edited_in), or a commit the reply cites. Otherwise the
 * reminder, quoting the lesson, waits for the session's next prompt
 * (pendingReminders.ts): a held Stop shows the user a hook error, and the
 * reminder reaches the model just as well one prompt later. A continuation
 * another Stop hook asked for (`stop_hook_active`) and subagents are left alone.
 */

import path from 'node:path'

import type { ModuleCtx } from '../../../core/ctx.js'
import { lastReply } from './ruleAudit.js'
import { addReminder } from './pendingReminders.js'
import { appendFire } from './ruleReview.js'
import { MemoryStore } from './store.js'

type Payload = { session_id?: string; transcript_path?: string; last_assistant_message?: string; stop_hook_active?: boolean; agent_id?: string }

const LESSON =
  /\b(?:i(?:'ll| will) (?:not|never)\b[^.\n]{0,80}\bagain\b|i won'?t\b[^.\n]{0,80}\bagain\b|lessons? (?:learned|noted|taken)|(?:noted|understood|got it)[,.;:]? (?:i(?:'ll| will)|going forward)|(?:going forward|from now on),? i(?:'ll| will)|i should have\b|my mistake\b)/i

/** How recently the fix must have been made: this turn, or the one before it. */
export const LESSON_WINDOW_MS = 30 * 60 * 1000

/**
 * The sentence a reply states a lesson in, outside quotes and code; null when
 * there is none. The whole sentence, since the reminder reaches a later turn.
 */
export const statedLesson = (reply: string): string | null => {
  const plain = reply
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ')
  const m = LESSON.exec(plain)
  if (!m) return null
  const before = plain.slice(0, m.index).split(/(?<=[.!?])\s+|\n/).pop() ?? ''
  const after = plain.slice(m.index).match(/^[^\n]*?(?:[.!?](?=\s|$)|$)/m)?.[0] ?? m[0]
  return (before + after).trim()
}

/** A commit the reply names: a short or full sha next to the word. */
const CITES_COMMIT = /\bcommit(?:ted)?\b[^.\n]{0,40}\b[0-9a-f]{7,40}\b|\b[0-9a-f]{7,40}\b[^.\n]{0,20}\bcommit/i

export default (payload: unknown, ctx?: ModuleCtx) => {
  const p = (payload ?? {}) as Payload
  if (!ctx?.db || p.agent_id || p.stop_hook_active || !p.session_id) return undefined
  try {
    const reply = p.last_assistant_message ?? (p.transcript_path ? lastReply(p.transcript_path) : '')
    const lesson = reply ? statedLesson(reply) : null
    if (!lesson) return undefined
    const store = new MemoryStore(ctx.db)
    const since = Date.now() - LESSON_WINDOW_MS
    const ruleIds = new Set(store.rules().map((r) => r.id))
    const kept = store
      .observedInto(p.session_id, ['edited_in'])
      .filter((e) => e.lastAt >= since)
      .some((e) => ruleIds.has(e.src) || store.get(e.src)?.shape === 'feedback')
    const fires = path.join(ctx.dataDir, 'rule-fires.jsonl')
    appendFire(fires, { at: Date.now(), rule: '(lesson gate)', session: p.session_id, event: 'Stop', what: 'lesson stated', findings: kept ? 0 : 1, outcome: 'reminded' })
    if (kept || CITES_COMMIT.test(reply)) return undefined
    addReminder(
      ctx.dataDir,
      p.session_id,
      'lesson',
      `Your reply stated a lesson ("${lesson}") but nothing this session makes it stick. ` +
        'Make it a mechanism fix if one exists (and cite the commit); otherwise write a rule memory: kind: rule, why, ' +
        'when: the trigger where it applies (always | tool:<name> | path:<glob> | keywords:<a,b>), and enforce: remind, audit, ' +
        'or deny for an outright prohibition. Then say which you did. If it truly needs neither, say why in one line.',
    )
    return undefined
  } catch (err) {
    ctx.log(`lesson gate skipped: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}
