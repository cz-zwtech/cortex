/**
 * The rule fire log and `cortex-rules review` (design H4, section 8).
 *
 * Every check a rule makes is logged, one JSON line each, in
 * <data>/memory/rule-fires.jsonl: which rule, which session and event, how many
 * findings, and the outcome. Review reads it to list the rules worth the user's
 * look. Nothing retires by itself: rules are theirs.
 */
import fs from 'node:fs'
import path from 'node:path'

import { STOPWORDS } from './relevance.js'
import type { Rule } from './rules.js'

export type Outcome = 'audited-clean' | 'audited-violation' | 'reminded' | 'denied' | 'overridden'
export type Fire = { at: number; rule: string; session?: string; event: string; what: string; findings: number; outcome: Outcome }

export const appendFire = (file: string, f: Fire): void => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(f) + '\n')
  } catch {
    /* a log that cannot be written must never break the session */
  }
}

/** The log's last `maxBytes`, parsed; a torn first line is skipped. */
export const readFires = (file: string, maxBytes = 2_000_000): Fire[] => {
  let text = ''
  try {
    const st = fs.statSync(file)
    const fd = fs.openSync(file, 'r')
    const len = Math.min(st.size, maxBytes)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, st.size - len)
    fs.closeSync(fd)
    text = buf.toString('utf-8')
  } catch {
    return []
  }
  return text.split('\n').flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as Fire] : []
    } catch {
      return []
    }
  })
}

// ── repeat offences: rules that fired and were broken anyway ───────────────

/** A user message that corrects the assistant. */
const CORRECTION = /\b(?:again|i told you|i said|stop (?:doing|using|adding)|not what i asked|how many times|you keep|you still|don'?t|do not|never)\b/i

/** Two-letter words that say nothing; the rest stay ("ui copy" is a rule's whole subject). */
const SHORT = new Set('no do it is to of in on at an as be by if or so up we me my us ok go he hi'.split(' '))

const contentWords = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !SHORT.has(w) && !STOPWORDS.has(w))

/** Adjacent content words: the phrases a rule is about ("ui copy", "commit messages"). */
const phrasesOf = (s: string) => {
  const w = contentWords(s)
  return new Set(w.slice(1).map((x, i) => `${w[i]} ${x}`))
}

export type Said = { text: string; at: number; after?: string | null }

/**
 * The user's corrections that a rule is about. A first version counted any
 * correcting message sharing two words with a rule, and then every rule
 * showed dozens of corrections, some older than the rule itself. Now a correction:
 *   - answers the assistant: the block before it in its session is the assistant's;
 *   - names the rule: a two-word phrase of its do or why, or one of its keywords;
 *   - comes after the rule was written;
 *   - counts once: a message is credited to the rule it names most.
 */
export const corrections = (rules: Rule[], said: Said[]): Map<string, number> => {
  const out = new Map<string, number>()
  const evidence = rules.map((r) => ({
    r,
    phrases: phrasesOf(`${r.do}\n${r.why}`),
    keys: r.when.startsWith('keywords:') ? r.when.slice(9).split(',').map((k) => k.trim().toLowerCase()).filter(Boolean) : [],
  }))
  for (const s of said) {
    if (!CORRECTION.test(s.text) || (s.after !== undefined && s.after !== 'assistant' && s.after !== 'tool-note')) continue
    const mine = phrasesOf(s.text)
    const words = new Set(contentWords(s.text))
    let best: { name: string; n: number } | undefined
    for (const e of evidence) {
      if (e.r.since !== undefined && s.at < e.r.since) continue
      const n = [...e.phrases].filter((p) => mine.has(p)).length + e.keys.filter((k) => words.has(k)).length
      if (n && (!best || n > best.n)) best = { name: e.r.name, n }
    }
    if (best) out.set(best.name, (out.get(best.name) ?? 0) + 1)
  }
  return out
}

const PROHIBITION = /^\s*(?:never|no |don'?t|do not|not )/i

/**
 * What to change about a rule that keeps being broken: one level stronger
 * (remind -> audit when there is a check to audit with, else deny for a
 * prohibition; audit -> deny), and a tool or path trigger widened to always
 * when it was broken away from that tool. Proposals only: rules are the user's.
 */
export const promotion = (r: Rule, violated: number, corrected: number): string[] => {
  const out: string[] = []
  if (r.enforce === 'remind' || r.enforce === 'none') {
    if (r.check.startsWith('regex:')) out.push(`enforce: ${r.enforce} -> enforce: audit`)
    else if (PROHIBITION.test(r.do)) out.push(`enforce: ${r.enforce} -> enforce: deny${/^(tool|path):/.test(r.when) ? '' : ' (with a tool: or path: trigger, so there is a call to refuse)'}`)
    else out.push(`enforce: ${r.enforce} -> enforce: audit, with check: regex:<what a violation looks like>`)
  } else if (r.enforce === 'audit') out.push('enforce: audit -> enforce: deny')
  if (/^(tool|path|cwd):/.test(r.when) && corrected > 0) out.push(`add an always-on companion (when: always, enforce: remind): it was broken away from ${r.when}`)
  if (violated + corrected === 0) return []
  return out
}

export const review = (
  rules: Rule[],
  firesFile: string,
  opts: { days: number; now?: number; sourceExists: (name: string) => boolean; noisyPerDay?: number; said?: Said[] },
): string[] => {
  const now = opts.now ?? Date.now()
  const since = now - opts.days * 86_400_000
  const fires = readFires(firesFile).filter((f) => f.at >= since)
  const by = (name: string) => fires.filter((f) => f.rule === name)
  const out: string[] = [`Rule review: ${rules.length} rule(s), ${fires.length} check(s) logged in the last ${opts.days} day(s).`]
  const section = (title: string, lines: string[]) => {
    out.push('', `${title}: ${lines.length ? '' : 'none'}`.trimEnd(), ...lines.map((l) => `  - ${l}`))
  }

  const today = new Date(now).toISOString().slice(0, 10)
  section(
    'Conditions to re-check (nothing lapses by itself)',
    rules
      .filter((r) => r.valid !== 'always')
      .sort((a, b) => (a.reviewBy ?? '9999').localeCompare(b.reviewBy ?? '9999'))
      .map((r) => `${r.name}: ${r.valid}${r.reviewBy ? ` (review by ${r.reviewBy}${r.reviewBy <= today ? ', DUE' : ''})` : ''}`),
  )
  section(
    'Reasons that may no longer hold (every source memory is gone)',
    rules.filter((r) => r.source.length && r.source.every((s) => !opts.sourceExists(s))).map((r) => `${r.name}: sources ${r.source.join(', ')} not found`),
  )
  section(
    'Violated under audit (candidates for remind or deny)',
    rules
      .map((r) => ({ r, v: by(r.name).filter((f) => f.outcome === 'audited-violation') }))
      .filter((x) => x.v.length)
      .sort((a, b) => b.v.length - a.v.length)
      .map((x) => `${x.r.name}: ${x.v.length} of ${by(x.r.name).length} checks found something (latest: ${x.v[x.v.length - 1]!.what})`),
  )
  const corrected = corrections(rules, (opts.said ?? []).filter((x) => x.at >= since))
  section(
    'Repeat offences (fired or stated, and broken anyway): proposed changes, not applied',
    rules
      .map((r) => {
        const mine = by(r.name)
        const violated = mine.filter((f) => f.outcome === 'audited-violation').length
        // Reminded, then violated in the same session: the reminder was there and lost.
        const lost = mine.filter((f, i) => f.outcome === 'reminded' && mine.slice(i + 1).some((g) => g.session === f.session && g.outcome === 'audited-violation')).length
        const c = corrected.get(r.name) ?? 0
        return { r, violated, lost, c, change: promotion(r, violated, c) }
      })
      .filter((x) => x.change.length && (x.violated >= 2 || x.lost > 0 || x.c > 0))
      .sort((a, b) => b.violated + b.c - (a.violated + a.c))
      .map((x) => `${x.r.name}: ${x.violated} violation(s), ${x.lost} after a reminder, ${x.c} correction(s) by the user. Change: ${x.change.join('; ')}`),
  )
  const perDay = opts.noisyPerDay ?? 20
  section(
    `Noisy (more than ${perDay} fires a day)`,
    rules.filter((r) => by(r.name).length / Math.max(1, opts.days) > perDay).map((r) => `${r.name}: ${by(r.name).length} fires`),
  )
  section(
    'Stale (has a trigger, never fired in the window: wrong trigger, or no longer relevant)',
    rules.filter((r) => r.when !== 'always' && r.enforce !== 'none' && !by(r.name).length).map((r) => `${r.name}: when ${r.when}`),
  )
  return out
}
