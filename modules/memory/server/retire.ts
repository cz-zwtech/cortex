/**
 * Retire: a memory out of recall, kept, and not coming back.
 *
 * `forget` deletes a row and tombstones one hash, only for records before it, so
 * the same text written again (a peer re-sweeping an old stub, a file that still
 * holds it) revives it. A retirement is a journal record covering EVERY version's
 * hash, with no sequence bound: any record of those texts, from any machine, lands
 * retired. New text under the name is a new version, an update (reconcile rung 1),
 * and the row is live again.
 *
 * The graph's retired state is derived: `retired_hashes` is rebuilt from the
 * journal, and a row is retired while its journal record is covered.
 */

import { bodyOf } from './consume.js'
import { frontmatterOf } from './frontmatter.js'
import { hashContent, type Journal, type JournalRecord, type RetirementRecord } from './journal.js'
import type { MemoryStore, Retirement } from './store.js'
import type { Memory } from './types.js'

export type RetireDeps = { store: MemoryStore; journal: Journal }

const toRetirement = (r: RetirementRecord): Retirement => ({
  memoryId: r.memoryId,
  at: r.appendedAt,
  by: r.by,
  ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}),
  ...(r.why ? { why: r.why } : {}),
})

/** Rebuild what the graph knows of retirements from the journal, and bring the rows in line. */
export const syncRetirements = ({ store, journal }: RetireDeps): void => {
  store.setRetiredHashes([...journal.retiredHashes()].map(([hash, r]) => ({ hash, retirement: toRetirement(r) })))
  store.syncRetiredRows()
}

/** Retirement records adopted from another machine, applied to this graph. */
export const adoptRetirements = (records: JournalRecord[], deps: RetireDeps): void => {
  if (!records.length) return
  syncRetirements(deps)
  for (const r of records) {
    if (r.kind !== 'retirement' && r.kind !== 'unretirement') continue
    // A row with no journal record here is retired by id: nothing else could cover it.
    if (deps.store.get(r.memoryId) && !deps.store.journalHashOf(r.memoryId)) {
      deps.store.setRetired(r.memoryId, r.kind === 'retirement' ? toRetirement(r) : null)
    }
    if (r.kind === 'retirement' && r.supersededBy && deps.store.get(r.memoryId) && deps.store.get(r.supersededBy)) {
      deps.store.addDeclaredEdge({ src: r.memoryId, dst: r.supersededBy, rel: 'evolved_into', label: 'retired' })
    }
  }
}

export type Version = { version: number; at: number; machine: string; hash: string; description: string; current: boolean }

/**
 * Every version of a memory the journal holds, oldest first: the records whose text went into
 * this row (the consume ledger says which), and the one it derives from now. A text written
 * more than once is one version.
 */
export const history = ({ store, journal }: RetireDeps, id: string): Version[] => {
  const current = store.journalHashOf(id)
  const seen = new Set<string>()
  const records = []
  for (const r of [...journal.read(), ...journal.peerRecords()]) {
    if (r.kind !== 'memory' || seen.has(r.contentHash)) continue
    if (r.contentHash !== current && store.consumedAs(hashContent(bodyOf(r.content))) !== id) continue
    seen.add(r.contentHash)
    records.push(r)
  }
  records.sort((a, b) => a.appendedAt - b.appendedAt)
  return records.map((r, i) => ({
    version: i + 1,
    at: r.appendedAt,
    machine: r.machine,
    hash: r.contentHash,
    description: frontmatterOf(r.content).description,
    current: r.contentHash === current,
  }))
}

export type Resolution = { memory: Memory } | { error: string }

/**
 * The memory an id or a name names. By name only when exactly one row fits: the
 * duplicates retire is for are same-name groups, so a name is ambiguous exactly
 * when retire is most wanted. `retired` picks which rows a name may mean.
 */
export const resolveMemory = (store: MemoryStore, ref: string, retired: boolean): Resolution => {
  const byId = store.get(store.resolveId(ref))
  if (byId) return { memory: byId }
  const rows = store.byName(ref).filter((m) => (m.retiredAt !== undefined) === retired)
  if (rows.length === 1) return { memory: rows[0]! }
  if (!rows.length) return { error: `no ${retired ? 'retired ' : 'live '}memory with id or name ${ref}` }
  return {
    error: [
      `${rows.length} ${retired ? 'retired ' : 'live '}memories are named ${ref}; name one by id:`,
      ...rows.map((m) => `  ${m.id}  ${m.scope}  ${m.machine}  ${new Date(m.authoredAt).toISOString().slice(0, 10)}`),
    ].join('\n'),
  }
}

export type RetireOptions = { by: string; supersededBy?: string; why?: string; now?: number }

export const retire = (deps: RetireDeps, id: string, opts: RetireOptions): RetirementRecord => {
  const { store, journal } = deps
  if (!store.get(id)) throw new Error(`no memory with id ${id}`)
  if (opts.supersededBy !== undefined) {
    if (opts.supersededBy === id) throw new Error('a memory cannot be superseded by itself')
    if (!store.get(opts.supersededBy)) throw new Error(`no memory with id ${opts.supersededBy} to supersede it`)
  }
  const record = journal.appendRetirement({
    memoryId: id,
    hashes: history(deps, id).map((v) => v.hash),
    ...(opts.supersededBy ? { supersededBy: opts.supersededBy } : {}),
    ...(opts.why ? { why: opts.why } : {}),
    by: opts.by,
    ...(opts.now !== undefined ? { appendedAt: opts.now } : {}),
  })
  syncRetirements(deps)
  if (!store.journalHashOf(id)) store.setRetired(id, toRetirement(record))
  if (opts.supersededBy) store.addDeclaredEdge({ src: id, dst: opts.supersededBy, rel: 'evolved_into', label: 'retired' })
  return record
}

/**
 * Clear a memory's retirement. It names the versions held here and every hash its retirement
 * listed: a version this node never held (kept home where it was written) would otherwise stay
 * covered on the node that holds it. `notHeld` counts those, for the caller to say.
 */
export const unretire = (deps: RetireDeps, id: string, opts: { by: string; now?: number }): { notHeld: number } => {
  const { store, journal } = deps
  if (!store.get(id)) throw new Error(`no memory with id ${id}`)
  const held = new Set(history(deps, id).map((v) => v.hash))
  const listed = [...journal.retiredHashes()].filter(([, r]) => r.memoryId === id).map(([hash]) => hash)
  const notHeld = listed.filter((h) => !held.has(h))
  journal.appendUnretirement({
    memoryId: id,
    hashes: [...held, ...notHeld],
    by: opts.by,
    ...(opts.now !== undefined ? { appendedAt: opts.now } : {}),
  })
  syncRetirements(deps)
  if (!store.journalHashOf(id)) store.setRetired(id, null)
  return { notHeld: notHeld.length }
}

export type DuplicatePlan = { kept: Memory[]; retire: Memory[]; supersededBy: Memory }[]

/**
 * What `duplicates --apply` does: in each (scope, name) group with more than one live row, keep
 * the rows named in `keep`, or else the newest authored, and retire the rest superseded by the
 * newest kept row.
 */
export const planDuplicates = (store: MemoryStore, keep: string[] = []): DuplicatePlan => {
  const wanted = new Set(keep)
  return store.duplicateGroups().map((group) => {
    const named = group.filter((m) => wanted.has(m.id))
    const kept = named.length ? named : [group[0]!]
    return { kept, retire: group.filter((m) => !kept.includes(m)), supersededBy: kept[0]! }
  })
}

export const applyDuplicates = (deps: RetireDeps, plan: DuplicatePlan, opts: { by: string }): number => {
  let retired = 0
  for (const g of plan) {
    for (const m of g.retire) {
      retire(deps, m.id, { by: opts.by, supersededBy: g.supersededBy.id, why: `duplicate of ${g.supersededBy.id}` })
      retired++
    }
  }
  return retired
}
