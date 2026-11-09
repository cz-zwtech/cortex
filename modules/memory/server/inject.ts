/**
 * Turning ranked memories into injected text, within a byte budget.
 *
 * Shared by both injection points — SessionStart's standing-context selection
 * and UserPromptSubmit's query recall — because the rendering and the budgeting
 * are identical and only the SELECTION differs. Two copies would drift, and the
 * drift would show up as one surface truncating differently from the other for
 * no stated reason.
 *
 * WHOLE BLOCKS ONLY. Half a memory reads as complete and the consumer cannot
 * tell it was cut — the same rule core applies when it drops a module's
 * contribution rather than trimming it.
 */

import type { Memory } from './types.js'

export type Rendered = {
  /** Empty when nothing fit. */
  text: string
  included: string[]
  /** Ranked, then did not fit. NEVER silent: cut is not the same as not found. */
  dropped: number
  bytes: number
}

/**
 * A standing rule as ONE line: its name and its description, which is written as the rule. Every
 * standing rule has to load in every session, so none carries its body; `cortex-memory show <name>`
 * gives the full text on demand. Falls back to the body's first line when there is no description.
 */
export const renderRuleLine = (m: Memory, maxChars: number): string => {
  const said = (m.description || m.content.trim().split('\n').find((l) => l.trim()) || '').trim().replace(/\s+/g, ' ')
  const cut = [...said].length > maxChars ? `${[...said].slice(0, maxChars - 1).join('').trimEnd()}…` : said
  return cut ? `- **${m.name}**: ${cut}` : `- **${m.name}**`
}

/**
 * Where a memory was written, when that was a project and not user-wide: the scope as stored
 * (an encoded cwd, which a dash in a dir name makes ambiguous to decode, so it is not decoded).
 * An answer that uses it can then say where it came from.
 * Adopted feedback is filed under user scope, so its project comes from its source path.
 */
export const originOf = (m: Pick<Memory, 'scope' | 'source'>): string => {
  if (m.scope && m.scope !== 'user') return ` (from ${m.scope})`
  // Feedback adopted from another machine is filed user-wide; its source still names the project dir.
  const project = /\/projects\/([^/]+)\/memory\//.exec(m.source ?? '')?.[1]
  return project ? ` (from ${project})` : ''
}

export const renderMemory = (m: Memory): string => {
  const head = `${m.description ? `${m.name} — ${m.description}` : m.name}${originOf(m)}`
  const body = m.content.trim()
  return body ? `- **${head}**\n  ${body.replace(/\n+/g, '\n  ')}` : `- **${head}**`
}

export const renderBlocks = (
  memories: Memory[],
  budgetBytes: number,
  heading: string,
): Rendered => {
  const parts: string[] = []
  const included: string[] = []
  let bytes = 0
  let dropped = 0

  for (const m of memories) {
    const block = renderMemory(m)
    const size = Buffer.byteLength(block, 'utf-8') + 1
    if (bytes + size > budgetBytes) {
      dropped++
      continue
    }
    parts.push(block)
    included.push(m.id)
    bytes += size
  }

  return {
    text: parts.length ? `${heading}\n\n${parts.join('\n')}` : '',
    included,
    dropped,
    bytes,
  }
}

/**
 * A hit at prompt time: its head, and the lines of its body that bear on the
 * query, inside a byte cap.
 *
 * Whole bodies were all-or-nothing against the prompt budget, so a memory
 * longer than the budget could never be shown at all (a roster and a meeting
 * note, each just over the budget, ranked and were skipped every time, while a
 * short off-topic memory filled the slot). An excerpt keeps the lines
 * that matched, a table row whole with its header, and says where the rest is.
 */
export const PROMPT_HIT_BYTES = 600
/** Below this a hit is shown as its head line alone. */
const MIN_EXCERPT_BYTES = 120

const bytes = (s: string) => Buffer.byteLength(s, 'utf-8')

const clip = (s: string, max: number) => {
  if (bytes(s) <= max) return s
  let out = ''
  for (const ch of s) {
    if (bytes(out + ch) > max - 3) break
    out += ch
  }
  return `${out.trimEnd()}…`
}

export const renderExcerpt = (m: Memory, score: (line: string) => number, maxBytes = PROMPT_HIT_BYTES): { text: string; trimmed: boolean } => {
  const whole = renderMemory(m)
  if (bytes(whole) <= maxBytes) return { text: whole, trimmed: false }

  const head = `- **${clip(m.description ? `${m.name} — ${m.description}` : m.name, 220)}${originOf(m)}**`
  const more = `  (excerpt; whole memory: cortex-memory show ${m.name})`
  let room = maxBytes - bytes(head) - bytes(more) - 2
  if (room < MIN_EXCERPT_BYTES) return { text: `${head}\n${more}`, trimmed: true }

  const lines = m.content.split('\n').map((l) => l.trim())
  const isRow = (i: number) => lines[i]!.startsWith('|')
  // The header of the table a row belongs to: the first row of its run, skipping the --- divider.
  const headerOf = (i: number) => {
    let j = i
    while (j > 0 && isRow(j - 1)) j--
    return j < i && !/^\|[\s|:-]+\|$/.test(lines[j]!) ? j : undefined
  }
  const ranked = lines
    .map((l, i) => ({ i, s: l ? score(l) : 0 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
  const picked = new Set<number>()
  const take = (i: number) => {
    if (picked.has(i)) return true
    const cost = bytes(lines[i]!) + 3
    if (cost > room) return false
    picked.add(i)
    room -= cost
    return true
  }
  for (const { i } of ranked) {
    const h = isRow(i) ? headerOf(i) : undefined
    if (h !== undefined && !picked.has(h) && bytes(lines[h]!) + bytes(lines[i]!) + 6 > room) continue
    if (h !== undefined) take(h)
    take(i)
  }
  // Nothing matched a line (the head did): lead with the opening lines.
  if (!picked.size) for (let i = 0; i < lines.length && room > 0; i++) if (lines[i] && !take(i)) break

  const order = [...picked].sort((a, b) => a - b)
  const body = order.map((i, n) => (n > 0 && i !== order[n - 1]! + 1 ? `…\n  ${lines[i]}` : lines[i])).join('\n  ')
  return { text: `${head}\n  ${body}\n${more}`, trimmed: true }
}

export type RenderedHits = Rendered & { trimmed: string[] }

/**
 * Every ranked hit gets a place: shortened to fit, never skipped for its size.
 * Each takes at most an equal share of what is left, so the first long hit
 * cannot spend the budget the others need.
 */
export const renderHits = (
  memories: Memory[],
  score: (line: string) => number,
  budgetBytes: number,
  heading: string,
): RenderedHits => {
  const parts: string[] = []
  const included: string[] = []
  const trimmed: string[] = []
  let used = bytes(heading) + 2
  let dropped = 0
  memories.forEach((m, n) => {
    const left = budgetBytes - used
    const share = Math.min(PROMPT_HIT_BYTES, Math.floor(left / (memories.length - n)))
    const r = renderExcerpt(m, score, Math.max(share, MIN_EXCERPT_BYTES))
    const size = bytes(r.text) + 1
    if (size > left) {
      dropped++
      return
    }
    parts.push(r.text)
    included.push(m.id)
    if (r.trimmed) trimmed.push(m.id)
    used += size
  })
  return { text: parts.length ? `${heading}\n\n${parts.join('\n')}` : '', included, trimmed, dropped, bytes: used }
}
