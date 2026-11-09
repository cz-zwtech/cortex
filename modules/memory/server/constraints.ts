/**
 * Constraints: the lines in memories that say what not to do, about whom or
 * what, wherever in the corpus they were written.
 *
 * A line like "the pricing calculator is under embargo: don't share it with Sam
 * yet" may live in a meeting-note memory, while the memory about the calculator
 * itself is the one recall shows when a deck for Sam is written. Shown alone,
 * the calculator lands on a slide for Sam. A constraint is attached to its
 * subjects, not to the memory it happens to sit in: the names it mentions and
 * the phrases it is about. Any prompt, shown memory or outbound write that
 * touches a subject brings the constraint with it.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { STOPWORDS, terms } from './relevance.js'
import type { MemoryStore } from './store.js'

const TRIGGER = new RegExp(
  '\\b(?:never|must not|mustn\'?t|should not|shouldn\'?t|not yet|avoid|' +
    'keep (?:it |this |that |them )?(?:private|confidential|secret|quiet|under wraps|between us)|' +
    'confidential|surprise|embargo(?:ed)?|off the record|under wraps|not for (?:sharing|distribution|external)|' +
    'without (?:asking|approval|permission|checking))\\b',
  'i',
)
/**
 * "Don't" as an instruction: opening the sentence or after please/so/and/but.
 * "We don't need it" states a fact; live on node-a it turned a note about an API
 * scope into a constraint on every outbound message.
 */
const DIRECTIVE_DONT = /(?:^|[.;:!?(]\s*|\b(?:please|so|and|but)\s+)(?:don'?t|do not)\b/i

const isConstraint = (sentence: string): boolean => TRIGGER.test(sentence) || DIRECTIVE_DONT.test(sentence)

/** A sentence that leans on the one before it for its subject. */
const PRONOUN_START = /^(?:it|this|that|they|these|those|he|she|them)\b/i

const MAX_CHARS = 300

/** The constraint statements in a memory body, each with the sentence that names its subject. */
export const constraintLines = (content: string): string[] => {
  const out: string[] = []
  for (const raw of content.split('\n')) {
    const line = raw.replace(/^[\s>*-]+|\*\*/g, '').trim()
    if (!line || line.startsWith('|') || line.startsWith('```')) continue
    const sentences = line.split(/(?<=[.!?;:])\s+/)
    const keep = new Set<number>()
    sentences.forEach((s, i) => {
      // A sentence with code in it is a technical rule; those live in the standing rules, not here.
      if (s.includes('`') || !isConstraint(s)) return
      keep.add(i)
      if (i > 0 && PRONOUN_START.test(s)) keep.add(i - 1)
    })
    if (!keep.size) continue
    let run: string[] = []
    const flush = () => {
      const text = run.join(' ').trim()
      if (text.split(/\s+/).length >= 4) out.push(text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1).trimEnd()}…` : text)
      run = []
    }
    sentences.forEach((s, i) => {
      if (keep.has(i)) run.push(s)
      else if (run.length) flush()
    })
    if (run.length) flush()
  }
  return out
}

// ── subjects ────────────────────────────────────────────────────────────────

const CALENDAR = new Set(
  ('monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december ' +
    'mon tue tues wed thu thur thurs fri sat sun jan feb mar apr jun jul aug sep sept oct nov dec today tomorrow').split(' '),
)

/** Names: capitalised words that are not a sentence's first word. */
const properNames = (text: string): string[] => {
  const out: string[] = []
  for (const sentence of text.split(/(?<=[.!?;:])\s+/)) {
    sentence
      .split(/[^A-Za-z0-9'-]+/)
      .filter(Boolean)
      .forEach((w, i) => {
        const lw = w.toLowerCase().replace(/'s$/, '')
        // Capitalised, not shouted: "WRITES" and "KNOWN WART" are emphasis, not names.
        if (i > 0 && /^[A-Z][a-z]/.test(w) && lw.length >= 3 && !CALENDAR.has(lw) && !STOPWORDS.has(lw)) out.push(lw)
      })
  }
  return out
}

/** Adjacent content words: the phrases a text is about ("pricing calculator", "release plan"). */
/** What is left of a contraction once split on the apostrophe ("don't" is "don" and "t"). */
const CONTRACTED = new Set('don doesn didn isn aren won wasn weren shouldn mustn couldn wouldn haven hasn hadn can'.split(' '))

const phrases = (text: string): string[] => {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !CONTRACTED.has(w))
  const out: string[] = []
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]}_${words[i + 1]}`)
  return out
}

/** The keys a constraint is about: `p:` a name it mentions, `b:` a phrase it uses. */
export const constraintKeys = (line: string): string[] => [...new Set([...properNames(line).map((n) => `p:${n}`), ...phrases(line).map((b) => `b:${b}`)])]

/**
 * The keys a context offers: every word its texts use, so a name is matched
 * however it is cased ("for riley" and "for Riley" both name Riley); and the
 * phrases of `topics` only. Phrases from a long text match by chance: live on
 * node-a, a bus message matched three unrelated technical rules on two-word runs.
 * A topic is a shown memory's name and description, which say what it is about.
 */
export const contextKeys = (texts: string[], topics: string[] = [], textPhrases = false): Set<string> => {
  const keys = new Set<string>()
  // Paths name the machine's layout, not the subject: every command here holds /home/<user>/
  // and a /tmp/claude-* scratch dir. A write's own folder and file name come in as a text.
  const unpathed = texts.map((t) => t.replace(/(?:[A-Za-z]+:\/\/|~?\/|\.\.?\/)[^\s<>"'`]*/g, ' '))
  for (const t of [...unpathed, ...topics]) for (const w of terms(t)) keys.add(`p:${w}`)
  for (const t of [...topics, ...(textPhrases ? unpathed : [])]) for (const b of phrases(t.replace(/[-_]+/g, ' '))) keys.add(`b:${b}`)
  return keys
}

// ── what may be shown where ─────────────────────────────────────────────────

/**
 * Privacy, from the scope for F7 (PM .135453): subjects from a private
 * place show only inside that place, and pay-type constraints only on the
 * machines named for them.
 */
export type Privacy = {
  /**
   * A memory whose scope or source names one of these shows only when the cwd does too. Set per
   * machine in data/memory/privacy.json: the module names no place, so with none set every place is open.
   */
  privatePlaces: string[]
  /**
   * Machine ids (or hostnames, by substring) where compensation-type
   * constraints may show. Set per machine in data/memory/privacy.json: the
   * module names no machine, so with none set they show nowhere.
   */
  compensationOn: string[]
}

export const DEFAULT_PRIVACY: Privacy = { privatePlaces: [], compensationOn: [] }

const COMPENSATION = /\b(?:compensation|salary|salaries|pay|paid|payment|wage|wages|equity|bonus|bonuses|stipend|retainer|invoice|invoiced|rate|rates|fee|fees|comp)\b/i

export const isCompensation = (line: string): boolean => COMPENSATION.test(line)

export const placeAllowed = (memory: { scope: string; source: string }, cwd: string | undefined, privacy: Privacy): boolean => {
  const where = `${memory.scope} ${memory.source}`.toLowerCase()
  const here = (cwd ?? '').toLowerCase()
  return privacy.privatePlaces.every((p) => !where.includes(p) || here.includes(p))
}

export const machineAllowsCompensation = (machine: string[], privacy: Privacy): boolean =>
  privacy.compensationOn.filter(Boolean).some((m) => machine.some((id) => id.toLowerCase().includes(m.toLowerCase())))

export const loadPrivacy = (dataDir: string): Privacy => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'privacy.json'), 'utf-8')) as Partial<Privacy>
    return {
      privatePlaces: Array.isArray(raw.privatePlaces) ? raw.privatePlaces.map(String) : DEFAULT_PRIVACY.privatePlaces,
      compensationOn: Array.isArray(raw.compensationOn) ? raw.compensationOn.map(String) : DEFAULT_PRIVACY.compensationOn,
    }
  } catch {
    return DEFAULT_PRIVACY
  }
}

// ── which constraints apply here ────────────────────────────────────────────

export type Applied = { memoryId: string; ord: number; name: string; text: string; on: string[] }

/** Shown at most this many at once: past it, a list of constraints stops being read. */
export const MAX_CONSTRAINTS = 5

/**
 * A subject named in this many constraint lines is everyone's, not a subject:
 * the operator's own name heads half the feedback memories, and matching on it
 * would bring every rule into every prompt.
 */
const commonKeys = (rows: { keys: string[] }[]): Set<string> => {
  const df = new Map<string, number>()
  for (const r of rows) for (const k of r.keys) df.set(k, (df.get(k) ?? 0) + 1)
  const cap = Math.max(10, rows.length * 0.05)
  const common = new Set([...df].filter(([, n]) => n > cap).map(([k]) => k))
  // Whoever this runs as is in every session, and so is the assistant: never the subject of one.
  common.add('p:claude')
  try {
    common.add(`p:${os.userInfo().username.toLowerCase()}`)
  } catch {
    // No passwd entry (a container): nothing to leave out.
  }
  return common
}

/**
 * The relevance gate. One matched key used to be enough, and then most prompts
 * that got constraints got the full cap, most of them about nothing the prompt
 * brought up: names that are ordinary words (linear, plane, site) matched
 * casual prompts.
 *
 * The evidence has to be in the text itself (the prompt, or what is being
 * written). A first version also counted the head of a memory recall chose to
 * show as strong evidence; replayed, it passed nearly everything, because recall
 * shows a memory about a person on an unrelated prompt and its constraints ride
 * in on it. What recall chose to show may corroborate the text; it never stands in
 * for it.
 *
 * A constraint passes on:
 *   - a known person's name in the text (people table);
 *   - a two-word phrase of the text that the constraint also uses (prompts only:
 *     a long write matches phrases by chance);
 *   - for this project's and user-wide memories only: two keys in the text, or
 *     one key in the text that a shown memory's head also names.
 */
export type Gate = {
  /** Words of known people's names (store.peopleTokens). */
  people: Set<string>
  /** The cwd's project scope: constraints from it, and from user scope, are in scope. */
  scope?: string
}

export const passesGate = (r: { scope: string }, inText: string[], topicWords: Set<string>, gate: Gate): boolean => {
  if (!inText.length) return false
  const person = inText.some((k) => k.startsWith('p:') && gate.people.has(k.slice(2)))
  const phrase = inText.some((k) => k.startsWith('b:'))
  const corroborated = inText.some((k) => k.startsWith('p:') && topicWords.has(k.slice(2)))
  const inScope = r.scope === 'user' || (gate.scope !== undefined && r.scope === gate.scope)
  return person || phrase || (inScope && (corroborated || inText.length >= 2))
}

export const applicableConstraints = (
  store: MemoryStore,
  ctx: {
    texts: string[]
    topics?: string[]
    cwd?: string
    machine: string[]
    privacy: Privacy
    skip?: (c: Applied) => boolean
    max?: number
    gate?: Gate
    /** The texts are a prompt: their two-word phrases are evidence too. */
    textPhrases?: boolean
  },
): Applied[] => {
  const all = store.constraintLines()
  if (!all.length) return []
  const common = commonKeys(all)
  const here = contextKeys(ctx.texts, ctx.topics, ctx.textPhrases ?? false)
  const topicWords = new Set((ctx.topics ?? []).flatMap((t) => [...terms(t)]))
  // What the text itself offers: the gate's evidence. Phrases only from a prompt, which is short.
  const inText = contextKeys(ctx.texts, [], ctx.textPhrases ?? false)
  const comp = machineAllowsCompensation(ctx.machine, ctx.privacy)
  return all
    .filter((r) => placeAllowed(r, ctx.cwd, ctx.privacy) && (comp || !isCompensation(r.text)))
    .map((r) => ({ r, on: r.keys.filter((k) => !common.has(k) && here.has(k)) }))
    .filter(({ on }) => on.length > 0)
    .filter(({ r, on }) => !ctx.gate || passesGate(r, on.filter((k) => inText.has(k)), topicWords, ctx.gate))
    .map(({ r, on }) => ({ a: { memoryId: r.memoryId, ord: r.ord, name: r.name, text: r.text, on }, names: on.filter((k) => k.startsWith('p:')).length, at: r.authoredAt }))
    .filter(({ a }) => !ctx.skip?.(a))
    .sort((x, y) => y.names - x.names || y.a.on.length - x.a.on.length || y.at - x.at)
    .slice(0, ctx.max ?? MAX_CONSTRAINTS)
    .map(({ a }) => a)
}

export const CONSTRAINT_HEADING = '## Cortex — constraints that apply here'

export const renderConstraints = (list: Applied[]): string =>
  list.length ? `${CONSTRAINT_HEADING}\n\n${list.map((c) => `- ${c.text} (from ${c.name})`).join('\n')}` : ''

// ── once per stretch of a session ──────────────────────────────────────────

const shownFile = (dataDir: string, session: string) => path.join(dataDir, 'constraints-shown', `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

const keyOf = (c: Pick<Applied, 'memoryId' | 'ord'>) => `${c.memoryId}#${c.ord}`

export const constraintsShownSince = (dataDir: string, session: string | undefined, since: number): Set<string> => {
  if (!session) return new Set()
  try {
    const seen = JSON.parse(fs.readFileSync(shownFile(dataDir, session), 'utf-8')) as Record<string, number>
    return new Set(Object.entries(seen).filter(([, at]) => at >= since).map(([k]) => k))
  } catch {
    return new Set()
  }
}

export const isShown = (seen: Set<string>, c: Applied): boolean => seen.has(keyOf(c))

export const markConstraintsShown = (dataDir: string, session: string | undefined, list: Applied[], at: number): void => {
  if (!session || !list.length) return
  try {
    const f = shownFile(dataDir, session)
    let seen: Record<string, number> = {}
    try {
      seen = JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, number>
    } catch {
      // First of the session.
    }
    for (const c of list) seen[keyOf(c)] = at
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(seen))
  } catch {
    // Showing a constraint twice is the cost of losing this, never a lost turn.
  }
}

// ── at session start: who and what is live, and what not to do about them ──

/** How far back "active" reaches. */
export const ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
export const MAX_ACTIVE = 8

/** Claude Code's project key for a cwd: every non-alphanumeric becomes a dash. */
export const scopeOfCwd = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

/**
 * The constraints a session should start with: those from this project's
 * memories, and those from any memory written or brought up in the last two
 * weeks, under the same privacy rules as everywhere else. Each is labelled with
 * the names it is about, so the list reads as a roster of live subjects.
 *
 * Replaces nothing: MEMORY.md was never read by Cortex. The start block loaded
 * standing feedback and threads only, none of it keyed to the project or to who
 * is in play, so a session about a client began knowing nothing about them.
 */
export const activeSubjects = (
  store: MemoryStore,
  ctx: { cwd?: string; machine: string[]; privacy: Privacy; asOf: number },
): { label: string; text: string; name: string }[] => {
  const all = store.constraintLines()
  if (!all.length) return []
  const common = commonKeys(all)
  const scope = ctx.cwd ? scopeOfCwd(ctx.cwd) : undefined
  const since = ctx.asOf - ACTIVE_WINDOW_MS
  const comp = machineAllowsCompensation(ctx.machine, ctx.privacy)
  const recent = new Map<string, boolean>()
  const isRecent = (r: (typeof all)[number]) => {
    if (!recent.has(r.memoryId)) recent.set(r.memoryId, r.authoredAt >= since || (store.lastSurfaced(r.memoryId) ?? 0) >= since)
    return recent.get(r.memoryId)!
  }
  return all
    .filter((r) => placeAllowed(r, ctx.cwd, ctx.privacy) && (comp || !isCompensation(r.text)))
    .filter((r) => (scope !== undefined && r.scope === scope) || isRecent(r))
    .sort((a, b) => b.authoredAt - a.authoredAt || a.ord - b.ord)
    .slice(0, MAX_ACTIVE)
    .map((r) => ({
      label: r.keys
        .filter((k) => k.startsWith('p:') && !common.has(k))
        .map((k) => k.slice(2).replace(/^./, (c) => c.toUpperCase()))
        .join(', '),
      text: r.text,
      name: r.name,
    }))
}

export const renderActiveSubjects = (list: { label: string; text: string; name: string }[]): string =>
  list.length
    ? `## Cortex — active subjects: constraints from this project and the last 14 days\n\n${list
        .map((s) => `- ${s.label ? `${s.label}: ` : ''}${s.text} (from ${s.name})`)
        .join('\n')}`
    : ''
