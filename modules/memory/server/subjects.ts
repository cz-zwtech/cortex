/**
 * Keeping the subject tables current, and reading them at query time.
 *
 * The tables are derived from memory text, so they are rebuilt per memory when
 * its content or the extractor changes. Catch-up is bounded: a prompt does a
 * slice of it within its budget, a sweep does the rest.
 */

import { constraintKeys, constraintLines } from './constraints.js'
import { extractPeople, roleQuery } from './entities.js'
import type { MemoryStore } from './store.js'

/** Bump when extraction changes, so every memory is read again. */
export const SUBJECT_VERSION = 3

export const indexSubjects = (store: MemoryStore, opts: { limit?: number; deadline?: number } = {}): number => {
  const batch = store.staleSubjects(SUBJECT_VERSION, opts.limit ?? Number.MAX_SAFE_INTEGER)
  let done = 0
  for (const m of batch) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) break
    const lines = constraintLines(m.content).map((text) => ({ text, keys: constraintKeys(text) }))
    store.setSubjects(m, SUBJECT_VERSION, extractPeople(m.content), lines)
    done++
  }
  if (batch.length < (opts.limit ?? Number.MAX_SAFE_INTEGER)) store.pruneSubjects()
  return done
}

/**
 * What a query's role words resolve to: for each term that names a role, the
 * memories stating who holds it, and the people's names and titles (which an
 * excerpt then matches on).
 */
export type Resolved = { byTerm: Map<string, Set<string>>; words: Set<string> }

export const resolveRoles = (store: MemoryStore, queryTerms: Iterable<string>): Resolved => {
  const byTerm = new Map<string, Set<string>>()
  const words = new Set<string>()
  for (const t of queryTerms) {
    const keys = roleQuery(t)
    if (!keys.length) continue
    const ids = new Set<string>()
    for (const p of store.peopleWithRoles(keys)) {
      ids.add(p.memoryId)
      for (const w of `${p.name} ${p.title}`.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3) words.add(w)
    }
    if (!ids.size) continue
    byTerm.set(t, ids)
    // "c-suite" also arrives as its part "suite" (relevance.ts terms): the part stands for the compound.
    for (const part of t.split(/[-_]+/)) if (part !== t && !byTerm.has(part)) byTerm.set(part, ids)
  }
  return { byTerm, words }
}
