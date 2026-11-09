/** This node's sync state, kept in its data dir and gossiped as its mind-state record (design 5.3). */
import fs from 'node:fs'
import path from 'node:path'

import { commit, KEEP, type Commit, type Vector } from './commits.js'

export type MindState = {
  /** This node's commits, newest first. */
  commits: Commit[]
  /** Central lineage ids this node has seen, newest first. */
  central: string[]
  /** The central commit this node's state is built on. */
  base?: string
  /** Synced from a peer because central was away (design 5.5). */
  degraded: boolean
  lastSyncAt?: number
}

export const stateFile = (dataDir: string) => path.join(dataDir, 'state.json')

export const loadState = (dataDir: string): MindState => {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf-8')) as Partial<MindState>
    return { commits: s.commits ?? [], central: s.central ?? [], degraded: !!s.degraded, ...(s.base ? { base: s.base } : {}), ...(s.lastSyncAt ? { lastSyncAt: s.lastSyncAt } : {}) }
  } catch {
    return { commits: [], central: [], degraded: false }
  }
}

export const saveState = (dataDir: string, s: MindState): void => {
  fs.mkdirSync(dataDir, { recursive: true })
  const tmp = `${stateFile(dataDir)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, stateFile(dataDir))
}

/** Record a commit; on central it also extends the canonical lineage. */
export const record = (s: MindState, next: { vv: Vector; bvv: Vector; at: number; node: string }, isCentral: boolean): MindState => {
  const commits = commit(s.commits, { ...next, ...(s.base && !isCentral ? { base: s.base } : {}) })
  return { ...s, commits, ...(isCentral ? { central: [commits[0]!.id, ...s.central].slice(0, KEEP), base: commits[0]!.id } : {}) }
}

/** The mind-state record a node gossips: small, and only the latest per node is kept. */
export const gossip = (s: MindState, opts: { node: string; vv: Vector; bvv: Vector; roles: string[]; at: number }) => ({
  node: opts.node,
  vv: opts.vv,
  bvv: opts.bvv,
  commits: s.commits.map((c) => c.id),
  ...(s.base ? { base: s.base } : {}),
  role: opts.roles,
  degraded: s.degraded,
  at: opts.at,
})
