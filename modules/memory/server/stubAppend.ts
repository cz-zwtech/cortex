/**
 * Text appended to a stub is an update to the memory the stub stands for.
 *
 * Once a memory file is consumed it holds only the stub line. A session that
 * adds to it with `cat >>` writes text with no frontmatter below the stub; the
 * splitter dropped the stub line and the text became a new memory named after
 * the file, which the ladder kept beside the original as same slug, unrelated
 * content (rung 1c). An update to a thread could go to a stray that way and the
 * thread it belonged to would never get it.
 *
 * Now: when exactly one memory came from the file, the appended text is added to
 * that memory's own text (frontmatter and all, from the journal) and ingested
 * as an update of it, through the normal gate. When none or several did, the
 * text is held in the file with a note saying how to update instead, so it is
 * never lost and never a stray.
 */

import type { Journal } from './journal.js'
import type { MemoryStore } from './store.js'
import type { Memory } from './types.js'

/** The memory a stubbed file stands for, with its full text as last written; undefined unless exactly one. */
export const stubTarget = (store: MemoryStore, journal: Journal, source: string): { memory: Memory; raw: string } | undefined => {
  const from = store.bySource(source).filter((m) => m.authorship !== 'extracted')
  if (from.length !== 1) return undefined
  const memory = from[0]!
  const hash = store.journalHashOf(memory.id)
  let raw: string | undefined
  if (hash) for (const r of journal.read()) if (r.kind === 'memory' && r.contentHash === hash) raw = r.content
  // No journal copy (a memory older than the journal): its head and body still make a whole memory.
  raw ??= `---\nname: ${memory.name}\ndescription: ${memory.description}\n---\n\n${memory.content}`
  return { memory, raw }
}

/** The memory's text with the appended text after it, as one whole memory. */
export const withAppended = (raw: string, appended: string): string => `${raw.trimEnd()}\n\n${appended.trim()}\n`
