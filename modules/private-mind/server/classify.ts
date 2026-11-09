/**
 * What stays home (design 5.2). Two rules, applied at different points:
 * - a working shape is classified working when memory ingests it (a classifier
 *   registered with memory: synchronous, from the text alone);
 * - a memory written by a member of a local role never leaves its machine. Which
 *   roles a session's member holds is comms' to say, asynchronously, so this is
 *   applied where a record would leave: when a sync bundle is built.
 */
import type { MindConfig } from './config.js'

type Shape = 'decision' | 'error' | 'workflow' | 'reference' | 'feedback' | 'pattern' | 'observation' | 'thread'

export const shapeRule =
  (cfg: MindConfig) =>
  (r: { shape: Shape }): 'working' | undefined =>
    cfg.working.shapes.includes(r.shape) ? 'working' : undefined

/** Whether a record written by a member holding these roles must stay on this machine. */
export const keptHome = (cfg: MindConfig, writerRoles: string[]): boolean => writerRoles.some((r) => cfg.localRoles.includes(r))

/**
 * A path or a project scope, in one comparable form: every separator, dot or
 * dash is a dash, and case is folded. Claude Code names a project by its dir
 * with "/" and "." turned to "-" (Northwind.Api.Orders becomes Northwind-Api-Orders), older
 * scopes kept the dots, and /mnt/e paths come from a case-blind filesystem.
 */
const norm = (p: string): string => p.replace(/[\/]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()

/**
 * Whether a memory belongs to a private place: its project scope, or its
 * session's working dir, at or under a local dir. Since the encoding cannot
 * tell "/" from "-" or ".", a sibling whose name extends a local dir's
 * (/x/northwind-tools beside /x/northwind) is kept home too: the safe side.
 */
export const placeKept = (cfg: MindConfig, at: { scope?: string; cwd?: string | null }): boolean =>
  cfg.localDirs.some((d) => {
    const e = norm(d)
    const under = (x: string) => {
      const n = norm(x)
      return n === e || n.startsWith(`${e}-`)
    }
    return (!!at.scope && under(at.scope)) || (!!at.cwd && under(at.cwd))
  })
