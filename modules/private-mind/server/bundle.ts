/**
 * Sync bundles (design 5.2, 5.6): what one node sends another, and how it is
 * taken in. A bundle is lines: journal records, gap markers, pointers and
 * dialogue blocks. What leaves this machine is decided here, and it fails
 * closed:
 *
 * - a memory written by a member of a local role never leaves, not even as a
 *   pointer; its seq goes as a gap;
 * - a memory whose writer is not known yet is not sent and gets no gap, so the
 *   receiver's vector stops below it and it is sent once its writer is known;
 *   a writer still unknown after the grace is given up on: held for good, a gap;
 * - working detail stays home, a pointer goes instead (and a gap for its seq);
 * - deletions and redactions go, unless their target was kept home: then they
 *   go as a gap, since their target id would name it. Kept-home hashes are
 *   remembered, because a redaction removes its target from this machine too;
 * - consolidation records always go;
 * - records this node adopted from others go on as they came: their origin
 *   already decided.
 *
 * Dialogue blocks follow their session: only knowledge sessions whose writer
 * is known and holds no local role.
 *
 * Anything the receiver's secret gate would refuse (a memory released from
 * quarantine here, say) is held, code secret-gate, and goes as a gap: the gate
 * refuses a whole part file, so one such line would stop every record with it.
 */
import { keptHome } from './classify.js'
import type { MindConfig } from './config.js'
import type { Pointer, Writer } from './store.js'

/** The parts of a journal record this module reads; the record itself travels untouched. */
export type Rec = { kind: string; machine: string; seq: number; session?: string; scope?: string; syncClass?: string; slug?: string; content?: string; contentHash?: string; targetHash?: string }
export type Block = { machine: string; session: string; mseq: number; [k: string]: unknown }
export type Line = { t: 'record'; r: Rec } | { t: 'pointer'; p: Pointer } | { t: 'block'; b: Block }
export type HeldCode = 'local-role' | 'local-place' | 'waiting' | 'given-up' | 'secret-gate'
/** What was held back: the record's id, slug and reason, never its content. */
export type Held = { record: string; code: HeldCode; why: string; scope?: string; slug?: string }

export type BuildInput = {
  self: string
  cfg: MindConfig
  /** The journal stream beyond the receiver's vector (gap markers included). */
  records: Rec[]
  /** Every memory record of this machine's own, sent or not: what decides whether a deletion may name its target. */
  ownMemories: Rec[]
  /** Dialogue blocks beyond the receiver's block vector. */
  blocks: Block[]
  /** Pointers this node holds from other machines, passed on. */
  pointers: Pointer[]
  writer: (session: string) => Writer
  /** A session whose memories are working detail by kind (a subagent, an agent, a headless run). */
  workingSession: (session: string) => boolean
  released: (machine: string, seq: number) => boolean
  /**
   * Whether the receiver's secret gate would refuse a line, as it reads the part
   * file: one such line would cost the whole part, so it is held here instead.
   */
  gateRefuses: (line: string) => boolean
  /** For a record with no sync class: whether its declared shape is one that stays home. */
  workingShape: (content: string) => boolean
  /** A memory of a private place (localDirs), by its scope or its session's working dir. */
  placeKept: (r: { scope?: string; session?: string }) => boolean
  /** Hashes kept home by earlier bundles, whose records may since have been redacted away here. */
  keptHashes: Set<string>
}

const summaryOf = (content = ''): string => {
  const d = content.match(/^---\s*\n[\s\S]*?^description:\s*(.+)$/m)?.[1]
  return (d ?? content.replace(/^---[\s\S]*?\n---\s*/, '').split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 200)
}

type Decision = { send: 'record' } | { send: 'pointer' } | { send: 'gap' | 'wait'; code: HeldCode; why: string }

/** What becomes of one of this machine's own memories. */
const decide = (o: BuildInput, r: Rec): Decision => {
  if (o.released(r.machine, r.seq)) return { send: 'record' }
  if (o.placeKept(r)) return { send: 'gap', code: 'local-place', why: `kept home: a private place (scope ${r.scope ?? '?'})` }
  if (r.session) {
    const w = o.writer(r.session)
    if (w.state === 'pending') return { send: 'wait', code: 'waiting', why: `waiting: the writer of session ${r.session.slice(0, 8)} is not known yet` }
    if (w.state === 'unresolvable') return { send: 'gap', code: 'given-up', why: `held: the writer of session ${r.session.slice(0, 8)} could not be found` }
    if (keptHome(o.cfg, w.roles)) return { send: 'gap', code: 'local-role', why: `kept home: written in a local role (${w.roles.filter((x) => o.cfg.localRoles.includes(x)).join(', ')})` }
  }
  // Records from before sync classes were recorded have none: the shape rule decides for them (PM, 28 Oct).
  const working = r.syncClass ? r.syncClass === 'working' : o.workingShape(r.content ?? '')
  return working ? { send: 'pointer' } : { send: 'record' }
}

export const buildBundle = (o: BuildInput): { lines: Line[]; held: Held[]; kept: string[]; waitingFrom?: number } => {
  const lines: Line[] = []
  const held: Held[] = []
  let waitingFrom: number | undefined
  const gap = (r: Rec) => lines.push({ t: 'record', r: { kind: 'gap', machine: r.machine, seq: r.seq } })
  const decided = o.ownMemories.filter((m) => m.contentHash).map((m) => ({ hash: m.contentHash!, d: decide(o, m).send }))
  // A deletion may not name a memory kept home (or sent only as a pointer). One of a memory
  // still waiting for its writer waits with it: once the memory goes, the deletion must follow.
  const kept = new Set([...o.keptHashes, ...decided.filter((x) => x.d === 'gap' || x.d === 'pointer').map((x) => x.hash)])
  const waiting = new Set(decided.filter((x) => x.d === 'wait').map((x) => x.hash))

  // The gate reads the part file's text, so a line is judged as it will be written.
  const refused = (l: Line) => o.gateRefuses(JSON.stringify(l))
  for (const r of o.records) {
    if (r.machine !== o.self) {
      if (refused({ t: 'record', r })) {
        held.push({ record: `${r.machine}:${r.seq}`, code: 'secret-gate', why: 'held: the secret gate would refuse it (passed on from another machine)', ...(r.slug ? { slug: r.slug } : {}) })
        gap(r)
      } else lines.push({ t: 'record', r })
      continue
    }
    if (r.kind === 'tombstone' || r.kind === 'redaction') {
      if (r.targetHash && kept.has(r.targetHash)) gap(r)
      else if (r.targetHash && waiting.has(r.targetHash)) waitingFrom = Math.min(waitingFrom ?? Infinity, r.seq)
      else lines.push({ t: 'record', r })
      continue
    }
    if (r.kind !== 'memory') {
      lines.push({ t: 'record', r })
      continue
    }
    const id = `${r.machine}:${r.seq}`
    const d = decide(o, r)
    if (d.send === 'wait') {
      held.push({ record: id, code: d.code, why: d.why, ...(r.scope ? { scope: r.scope } : {}), ...(r.slug ? { slug: r.slug } : {}) })
      waitingFrom = Math.min(waitingFrom ?? Infinity, r.seq)
    } else if (d.send === 'gap') {
      held.push({ record: id, code: d.code, why: d.why, ...(r.scope ? { scope: r.scope } : {}), ...(r.slug ? { slug: r.slug } : {}) })
      gap(r)
    } else if (d.send === 'pointer') {
      const p: Line = { t: 'pointer', p: { memory: id, ...(r.slug ? { slug: r.slug } : {}), summary: summaryOf(r.content), owner: { node: o.self, ...(r.session ? { session: r.session } : {}) } } }
      if (!refused(p)) lines.push(p)
      gap(r)
    } else if (refused({ t: 'record', r })) {
      held.push({ record: id, code: 'secret-gate', why: 'held: the secret gate would refuse it (released here, or scanned more strictly there)', ...(r.scope ? { scope: r.scope } : {}), ...(r.slug ? { slug: r.slug } : {}) })
      if (r.contentHash) kept.add(r.contentHash)
      gap(r)
    } else lines.push({ t: 'record', r })
  }

  for (const p of o.pointers) if (!refused({ t: 'pointer', p })) lines.push({ t: 'pointer', p })

  for (const b of o.blocks) {
    if (refused({ t: 'block', b })) continue
    if (b.machine !== o.self) {
      lines.push({ t: 'block', b })
      continue
    }
    const w = o.writer(b.session)
    if (w.state !== 'resolved' || keptHome(o.cfg, w.roles) || o.workingSession(b.session) || o.placeKept({ session: b.session })) continue
    lines.push({ t: 'block', b })
  }
  return { lines, held, kept: [...kept], ...(waitingFrom !== undefined ? { waitingFrom } : {}) }
}

export const toNdjson = (lines: Line[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '')

export const fromNdjson = (text: string): { lines: Line[]; bad: number } => {
  const lines: Line[] = []
  let bad = 0
  for (const l of text.split('\n')) {
    if (!l.trim()) continue
    try {
      const x = JSON.parse(l) as Line
      if ((x.t === 'record' && x.r) || (x.t === 'pointer' && x.p?.memory) || (x.t === 'block' && x.b)) lines.push(x)
      else bad++
    } catch {
      bad++
    }
  }
  return { lines, bad }
}

export type ApplyPorts = {
  adoptRecords: (records: unknown[]) => { added: number; rejected: number; materialized?: string[]; removed?: number }
  adoptBlocks: (blocks: unknown[]) => { added: number; updated: number; rejected: number }
  putPointers: (ps: Pointer[]) => number
}

/** Take a bundle in. Every part is idempotent, so a bundle applied twice, or cut short and resent, changes nothing more. */
export const applyBundle = (lines: Line[], ports: ApplyPorts) => {
  const records = lines.filter((l): l is Extract<Line, { t: 'record' }> => l.t === 'record').map((l) => l.r)
  const blocks = lines.filter((l): l is Extract<Line, { t: 'block' }> => l.t === 'block').map((l) => l.b)
  const pointers = lines.filter((l): l is Extract<Line, { t: 'pointer' }> => l.t === 'pointer').map((l) => l.p)
  const r = ports.adoptRecords(records)
  const b = ports.adoptBlocks(blocks)
  return { records: r, blocks: b, pointers: ports.putPointers(pointers) }
}
