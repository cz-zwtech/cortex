/**
 * Which memories are knowledge and which are working detail (private mind
 * design 5.2, D5). Knowledge leaves the machine when minds sync; working
 * detail stays home and only a pointer to it travels. Memory records the
 * class and never acts on it.
 *
 * Decided, in order:
 * 1. the memory's own frontmatter: `sync: shared` is knowledge, `sync: local` is working;
 * 2. classifiers other modules register (private mind adds its shape rules);
 * 3. the session that wrote it: a subagent, a named agent or a headless run is
 *    working; an interactive session, or none, is knowledge.
 */
import type { Shape } from './types.js'

export type SyncClass = 'knowledge' | 'working'
export type SessionInfo = { entrypoint?: string | null; agent?: string | null; parent?: string | null }
export type ClassifyInput = { content: string; scope: string; shape: Shape; session?: SessionInfo }
export type Classifier = (r: ClassifyInput) => SyncClass | undefined

const classifiers: Classifier[] = []

/** Add a rule. Rules registered later are asked first. Returns the way to remove it. */
export const registerClassifier = (fn: Classifier): (() => void) => {
  classifiers.unshift(fn)
  return () => {
    const i = classifiers.indexOf(fn)
    if (i >= 0) classifiers.splice(i, 1)
  }
}

const declared = (content: string): SyncClass | undefined => {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)
  const v = fm?.[1]!.match(/^sync:\s*["']?(shared|local)["']?\s*$/m)?.[1]
  return v === 'shared' ? 'knowledge' : v === 'local' ? 'working' : undefined
}

export const bySession = (s?: SessionInfo): SyncClass => {
  if (!s) return 'knowledge'
  if (s.parent || s.agent) return 'working'
  if (s.entrypoint?.startsWith('sdk')) return 'working'
  return 'knowledge'
}

export const classify = (r: ClassifyInput): SyncClass => {
  const own = declared(r.content)
  if (own) return own
  for (const fn of classifiers) {
    const c = fn(r)
    if (c) return c
  }
  return bySession(r.session)
}
