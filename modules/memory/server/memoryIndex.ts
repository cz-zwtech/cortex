/**
 * MEMORY.md becomes a Cortex output: the harness keeps loading it, but it no
 * longer carries memory.
 *
 * HOW THE HARNESS USES IT. Claude Code's auto memory loads each project's
 * MEMORY.md into every session (the first 200 lines or 25KB; Claude Code memory
 * docs), and its system prompt tells the model to keep it as an index: one line
 * per memory, `- [Title](file.md) — hook`, with the memory itself in file.md.
 * It is not settings: permissions and hooks live in settings.json, and
 * instructions in CLAUDE.md. But it is free text, so a person or a session can
 * have put anything there.
 *
 * WHAT THE RENDER REMOVES, AND ONLY THAT (sweep out the memory, never
 * anything else that happens to live there):
 *   an index line, `- [..](path.md) ..`, whose target file is now the Cortex stub.
 * Its memory is in Cortex, so the line is only a stale pointer. Everything
 * else is kept verbatim: headings with content, prose, rules, anything that
 * looks like settings, links to files that still hold real content (not yet
 * ingested, or held by the secret gate), and links to files that are missing.
 * A heading is dropped only when the render emptied its section entirely.
 *
 * At the top it writes one generic block pointing at /cortex-memory, the same
 * principle as the stub: nothing per memory. The first render keeps the
 * original beside it as MEMORY.md.pre-cortex (not .md, so nothing reads it as
 * memory); the first-sweep backup holds it too.
 */
import fs from 'node:fs'
import path from 'node:path'

import { STUB_LINE } from './consume.js'

export const BLOCK_START = '<!-- cortex:memory -->'
export const BLOCK_END = '<!-- /cortex:memory -->'
export const BLOCK = [
  BLOCK_START,
  'Memory for this project lives in Cortex. For any memory question run /cortex-memory recall <words>, then /cortex-memory show <id>. Memory files here are pointers, not memories.',
  BLOCK_END,
].join('\n')

const INDEX_LINE = /^\s*[-*]\s+\[[^\]]*\]\(([^)\s]+\.md)\)/
const HEADING = /^(#{1,6})\s/

const isStub = (file: string): boolean => {
  try {
    return fs.readFileSync(file, 'utf-8').trim() === STUB_LINE
  } catch {
    return false
  }
}

export type RenderReport = { changed: boolean; removed: number; kept: number }

export const renderMemoryIndex = (dir: string): RenderReport => {
  const file = path.join(dir, 'MEMORY.md')
  let before: string
  try {
    before = fs.readFileSync(file, 'utf-8')
  } catch {
    return { changed: false, removed: 0, kept: 0 }
  }

  const body = before.replace(new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}\\n*`), '')
  const lines = body.split('\n')
  const removedAt = new Set<number>()
  let kept = 0
  lines.forEach((l, i) => {
    const m = INDEX_LINE.exec(l)
    if (!m) return
    const target = path.resolve(dir, m[1]!)
    if (isStub(target)) removedAt.add(i)
    else kept++
  })

  // Drop a heading only when the render emptied its whole section.
  const dropHeading = new Set<number>()
  lines.forEach((l, i) => {
    const h = HEADING.exec(l)
    if (!h) return
    let removedHere = 0
    let remaining = 0
    for (let j = i + 1; j < lines.length; j++) {
      const hj = HEADING.exec(lines[j]!)
      if (hj && hj[1]!.length <= h[1]!.length) break
      if (hj) {
        remaining++ // a sub-heading keeps its parent heading
        continue
      }
      if (removedAt.has(j)) removedHere++
      else if (lines[j]!.trim()) remaining++
    }
    if (removedHere > 0 && remaining === 0) dropHeading.add(i)
  })

  const out = lines
    .filter((_, i) => !removedAt.has(i) && !dropHeading.has(i))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const next = `${BLOCK}\n${out ? `\n${out}\n` : ''}`
  if (next === before) return { changed: false, removed: removedAt.size, kept }

  const original = `${file}.pre-cortex`
  if (!fs.existsSync(original)) fs.writeFileSync(original, before)
  fs.writeFileSync(file, next)
  return { changed: true, removed: removedAt.size, kept }
}

// ── TAKE IN, THEN REDUCE (option B, 18 Oct) ──────────────────────────────────
//
// The render above keeps every line that is not a stale pointer, which is how
// V1 prose ("This file is a slim always-loaded subset...") and rules written
// straight into MEMORY.md stayed behind, out of date and out of Cortex. The
// design: take those lines in first, then reduce. Each section's prose becomes
// a memory FILE in the same folder, so the ordinary sweep ingests it (and
// stubs it): nothing here writes to the store. A section under a rules heading
// is written `standing: true`. MEMORY.md is then the generic block plus the
// pointers that still resolve to nothing in Cortex, each with its reason.

const RULES_HEADING = /standing|rule|preference|feedback|always/i
const slugOf = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'top'

export type TakeInPlan = {
  /** Memory files to write: one per section that holds prose. */
  takeIn: { file: string; heading: string; standing: boolean; lines: number; content: string }[]
  /** Index lines whose memory is already in Cortex (the file is a stub): dropped. */
  stale: number
  /** Index lines that point at something not in Cortex, kept with the reason. */
  unresolved: { line: string; reason: string }[]
  /** MEMORY.md as it would be written. */
  next: string
}

export const planTakeIn = (dir: string): TakeInPlan | undefined => {
  const file = path.join(dir, 'MEMORY.md')
  let before: string
  try {
    before = fs.readFileSync(file, 'utf-8')
  } catch {
    return undefined
  }
  const body = before.replace(new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}\\n*`), '')
  const sections = new Map<string, string[]>()
  const unresolved: TakeInPlan['unresolved'] = []
  let stale = 0
  let heading = ''
  for (const line of body.split('\n')) {
    const h = HEADING.exec(line)
    if (h) {
      heading = line.replace(/^#+\s*/, '').trim()
      continue
    }
    const link = INDEX_LINE.exec(line)
    if (link) {
      const target = path.resolve(dir, link[1]!)
      if (isStub(target)) stale++
      else if (!fs.existsSync(target)) unresolved.push({ line: line.trim(), reason: 'missing: the file is not there' })
      else unresolved.push({ line: line.trim(), reason: 'not in Cortex yet: the next sweep ingests it, or the secret gate holds it (cortex-memory quarantine)' })
      continue
    }
    if (!line.trim()) continue
    const lines = sections.get(heading) ?? []
    lines.push(line)
    sections.set(heading, lines)
  }
  const takeIn: TakeInPlan['takeIn'] = []
  for (const [h, lines] of sections) {
    const standing = RULES_HEADING.test(h)
    const name = `memory-md-${slugOf(h)}`
    const content = [
      '---',
      `name: ${name}`,
      `description: ${(h || 'MEMORY.md, before any heading').replace(/\n/g, ' ')} (taken in from MEMORY.md)`,
      `type: ${standing ? 'feedback' : 'reference'}`,
      ...(standing ? ['standing: true'] : []),
      '---',
      '',
      ...lines,
      '',
    ].join('\n')
    takeIn.push({ file: path.join(dir, `${name}.md`), heading: h, standing, lines: lines.length, content })
  }
  const kept = unresolved.length
    ? `\n## Not in Cortex yet\n${unresolved.map((u) => `${u.line}  (${u.reason})`).join('\n')}\n`
    : ''
  return { takeIn, stale, unresolved, next: `${BLOCK}\n${kept}` }
}

/** Write the planned memory files (never over an existing one), keep the original, write the reduced MEMORY.md. */
export const applyTakeIn = (dir: string, plan: TakeInPlan, stamp: string): { written: string[]; skipped: string[]; backup: string } => {
  const file = path.join(dir, 'MEMORY.md')
  const backup = `${file}.before-take-in-${stamp}`
  fs.copyFileSync(file, backup)
  const original = `${file}.pre-cortex`
  if (!fs.existsSync(original)) fs.copyFileSync(file, original)
  const written: string[] = []
  const skipped: string[] = []
  for (const t of plan.takeIn) {
    try {
      fs.writeFileSync(t.file, t.content, { flag: 'wx' })
      written.push(t.file)
    } catch {
      skipped.push(t.file)
    }
  }
  // Only reduce when every section was taken in: a skipped one must stay readable in MEMORY.md.
  if (!skipped.length) fs.writeFileSync(file, plan.next)
  return { written, skipped, backup }
}
