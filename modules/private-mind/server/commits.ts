/**
 * Commit-style sync ids (design 5.4): a named, chained snapshot of a node's
 * version vectors. They make "which version am I on" readable and finding the
 * delta between two nodes quick; the vectors stay the ground truth, so a lost
 * history costs speed, never correctness.
 */
import { createHash } from 'node:crypto'

export type Vector = Record<string, number>
export type Commit = { id: string; parent?: string; vv: Vector; bvv: Vector; at: number; node: string; base?: string }

export const KEEP = 5

/** Key order never changes an id. */
export const canonical = (v: Vector): string => JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]))

export const commitId = (c: Omit<Commit, 'id' | 'base'>): string =>
  createHash('sha256').update(`${c.parent ?? ''}|${canonical(c.vv)}|${canonical(c.bvv)}|${c.at}|${c.node}`).digest('hex')

export const short = (id: string): string => id.slice(0, 12)

/** The next commit on a chain, newest first, keeping the last KEEP. */
export const commit = (chain: Commit[], next: { vv: Vector; bvv: Vector; at: number; node: string; base?: string }): Commit[] => {
  const parent = chain[0]?.id
  const c: Commit = { ...next, ...(parent ? { parent } : {}), id: commitId({ ...next, ...(parent ? { parent } : {}) }) }
  return [c, ...chain].slice(0, KEEP)
}

/**
 * Where two nodes last agreed: the newest of my commits the other also holds.
 * Its vectors are a known common point, so the delta is everything beyond
 * them. Undefined: no shared commit, so a plain vector diff (or a full sync).
 */
export const sharedPoint = (mine: Commit[], theirs: string[]): Commit | undefined => {
  const t = new Set(theirs)
  return mine.find((c) => t.has(c.id))
}
