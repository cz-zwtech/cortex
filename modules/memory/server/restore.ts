/**
 * After a compaction: this session's own working set, back in front of it.
 *
 * SessionStart fires with source "compact" after every compaction, and Cortex
 * already re-injects the standing block there. What the summary alone carries
 * for the session's OWN work is whatever the summariser kept. Cortex holds the
 * rest as ids it wrote while the session ran:
 *
 *   - the threads this session wrote (its resume anchors);
 *   - the other memories it wrote (its decisions);
 *   - the memories its replies used (F2 grading);
 *   - the constraints it was shown.
 *
 * One line each, inside a budget. Read-only, and only after a compaction.
 */

import { constraintsShownSince } from './constraints.js'
import type { MemoryStore } from './store.js'
import type { Memory } from './types.js'

export const RESTORE_BUDGET_BYTES = 2_400
const PER_SECTION = 8
const LINE_CHARS = 200

const line = (m: Pick<Memory, 'name' | 'description'>) => {
  const s = m.description ? `${m.name} — ${m.description}` : m.name
  return `- ${s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS - 1)}…` : s}`
}

export const buildRestore = (store: MemoryStore, dataDir: string, session: string): string => {
  const pick = (rel: 'edited_in' | 'used_in') =>
    store
      .observedInto(session, [rel])
      .map((e) => store.get(e.src))
      .filter((m): m is Memory => !!m)
  const wrote = pick('edited_in')
  const threads = wrote.filter((m) => m.shape === 'thread').slice(0, PER_SECTION)
  const decisions = wrote.filter((m) => m.shape !== 'thread').slice(0, PER_SECTION)
  const seen = new Set(wrote.map((m) => m.id))
  const used = pick('used_in').filter((m) => !seen.has(m.id)).slice(0, PER_SECTION)
  const shownKeys = constraintsShownSince(dataDir, session, 0)
  const constraints = shownKeys.size
    ? store
        .constraintLines()
        .filter((c) => shownKeys.has(`${c.memoryId}#${c.ord}`))
        .slice(0, PER_SECTION)
        .map((c) => `- ${c.text} (from ${c.name})`)
    : []

  const sections: [string, string[]][] = [
    ['Threads this session wrote', threads.map(line)],
    ['Decisions and notes this session wrote', decisions.map(line)],
    ['Memories this session used', used.map(line)],
    ['Constraints this session was shown', constraints],
  ]
  const parts: string[] = []
  let bytes = 0
  for (const [title, lines] of sections) {
    if (!lines.length) continue
    const block = `**${title}:**\n${lines.join('\n')}`
    const size = Buffer.byteLength(block, 'utf-8') + 2
    if (bytes + size > RESTORE_BUDGET_BYTES) break
    parts.push(block)
    bytes += size
  }
  return parts.length
    ? `## Cortex — this session, restored after compaction\n\n${parts.join('\n\n')}\n\n` +
        'Use cortex-memory show <name> for any of these in full.'
    : ''
}
