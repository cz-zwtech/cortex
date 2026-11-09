/**
 * One side of a sync, through ports to memory and comms (design 5.6): make a
 * bundle for a peer from what it says it holds, or take one in. The transport
 * (comms over the home mesh) is the caller's; this part never touches it.
 */
import { applyBundle, buildBundle, type Block, type Line, type Rec } from './bundle.js'
import { scanForSecrets } from '../../../core/secrets.js'
import { placeKept, shapeRule } from './classify.js'
import type { Vector } from './commits.js'
import type { MindConfig } from './config.js'
import type { MindStore, Writer } from './store.js'

export type SessionInfo = { entrypoint?: string | null; agent?: string | null; parent?: string | null; cwd?: string | null }
/** comms' answer: never bound to a member; bound, with its roles; or bound to one no longer known (roles undefined). */
export type SessionWriter = { bound: false } | { bound: true; member: string; roles: string[] | undefined }

export type Ports = {
  versionVector: () => Vector
  journalStream: (since: Vector) => Rec[]
  journalAdopt: (records: unknown[]) => { added: number; rejected: number; materialized?: string[]; removed?: number }
  blockVector: () => Vector
  blockStream: (since: Vector) => Block[]
  blockAdopt: (blocks: unknown[]) => { added: number; updated: number; rejected: number }
  /** Undefined when comms is absent or cannot answer: unknown, never "no roles". */
  sessionRoles?: (session: string) => Promise<SessionWriter | undefined>
  sessionInfo?: (session: string) => SessionInfo | undefined
  /** A memory's shape, as memory reads it from the text (memory.shapeOf). */
  shapeOf: (content: string) => string
}

/**
 * A subagent writes for the session that started it: its parent, from the
 * context store, or from its id (`<parent>/agent-<id>`). A subagent is never
 * bound to a member itself, so asking about it directly would read as "no roles".
 */
export const writerSession = (s: string, info?: SessionInfo): string => info?.parent ?? (s.includes('/agent-') ? s.slice(0, s.indexOf('/agent-')) : s)

/** Ask comms for the writer of every session not known yet. First answer is kept; no answer leaves it pending, and fails closed. */
export const resolveWriters = async (store: MindStore, sessions: Iterable<string>, ports: Pick<Ports, 'sessionRoles' | 'sessionInfo'>, now = Date.now()): Promise<void> => {
  for (const s of new Set(sessions)) {
    if (store.writer(s)?.state === 'resolved') continue
    const asked = writerSession(s, ports.sessionInfo?.(s))
    let w: SessionWriter | undefined
    try {
      w = await ports.sessionRoles?.(asked)
    } catch {
      w = undefined
    }
    if (w && !w.bound) store.unbound(s, now)
    else if (w?.roles) store.resolve(s, w.roles, now)
    else store.unresolved(s, now)
  }
}

const isWorkingSession = (i?: SessionInfo): boolean => !!i && (!!i.parent || !!i.agent || !!i.entrypoint?.startsWith('sdk'))

/** A bundle for a peer (`to`) that holds `since`. */
export const makeBundle = async (o: { ports: Ports; store: MindStore; cfg: MindConfig; self: string; since: { vv: Vector; bvv: Vector }; to?: string; now?: number }) => {
  const now = o.now ?? Date.now()
  const ownMemories = o.ports.journalStream({}).filter((r) => r.machine === o.self && r.kind === 'memory')
  const records = o.ports.journalStream(o.since.vv)
  const blocks = o.ports.blockStream(o.since.bvv)
  await resolveWriters(o.store, [...ownMemories.flatMap((r) => (r.session ? [r.session] : [])), ...blocks.filter((b) => b.machine === o.self).map((b) => b.session)], o.ports, now)
  const writer = (s: string): Writer => o.store.writer(s) ?? o.store.unresolved(s, now)
  const built = buildBundle({
    self: o.self,
    cfg: o.cfg,
    records,
    ownMemories,
    blocks,
    // Pointers held from others go on to third nodes, never back to the node that owns them.
    pointers: o.store.pointers().filter((p) => p.owner.node !== o.self && p.owner.node !== o.to),
    writer,
    workingSession: (s) => isWorkingSession(o.ports.sessionInfo?.(s)),
    gateRefuses: (line) => scanForSecrets(line).length > 0,
    workingShape: (content) => shapeRule(o.cfg)({ shape: o.ports.shapeOf(content) as never }) === 'working',
    placeKept: (r) => placeKept(o.cfg, { scope: r.scope, cwd: r.session ? o.ports.sessionInfo?.(r.session)?.cwd : undefined }),
    released: (m, seq) => o.store.isReleased(m, seq),
    keptHashes: o.store.keptHashes(),
  })
  o.store.keep(built.kept)
  o.store.setHeld(built.held, now)
  return built
}

/** Take a bundle in: records and blocks into memory, pointers into this module's store. */
export const takeBundle = (o: { ports: Ports; store: MindStore; lines: Line[] }) =>
  applyBundle(o.lines, { adoptRecords: o.ports.journalAdopt, adoptBlocks: o.ports.blockAdopt, putPointers: (ps) => o.store.putPointers(ps) })
