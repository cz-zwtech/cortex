/**
 * Records adopted from other machines, told to listeners in the host process
 * (private mind design 3.2: `mesh.adopted`). The daemon writes adopted records
 * into the shared log from its own process; one watcher here notices, through
 * SQLite's data_version (which moves only for other connections' writes), and
 * hands each subscriber the new records of the kinds it asked for. Consumers
 * no longer poll the log themselves.
 */
import type { MeshLog, MeshRecord } from './log.js'

export const ADOPTED_CHECK_MS = 1_000

type Sub = { kinds: Set<string>; fn: (records: MeshRecord[]) => void }

export class AdoptedWatch {
  #subs = new Set<Sub>()
  #cursor: number
  #version: number
  #timer: NodeJS.Timeout

  constructor(
    private log: MeshLog,
    everyMs = ADOPTED_CHECK_MS,
  ) {
    this.#cursor = (log.db.prepare('SELECT COALESCE(MAX(rowid), 0) n FROM records').get() as { n: number }).n
    this.#version = log.db.pragma('data_version', { simple: true }) as number
    this.#timer = setInterval(() => this.check(), everyMs)
    this.#timer.unref()
  }

  /** Listen for adopted records of some kinds. Returns the way to stop. */
  subscribe(kinds: string[], fn: (records: MeshRecord[]) => void): () => void {
    const sub = { kinds: new Set(kinds), fn }
    this.#subs.add(sub)
    return () => this.#subs.delete(sub)
  }

  /** Look for new records now. Called on a timer; public so a caller can force it. */
  check(): void {
    const v = this.log.db.pragma('data_version', { simple: true }) as number
    if (v === this.#version) return
    this.#version = v
    const rows = this.log.db
      .prepare('SELECT rowid, * FROM records WHERE rowid > ? AND origin != ? AND purged = 0 ORDER BY rowid')
      .all(this.#cursor, this.log.origin) as (MeshRecord & { rowid: number })[]
    if (!rows.length) return
    this.#cursor = rows.at(-1)!.rowid
    for (const sub of this.#subs) {
      const mine = rows.filter((r) => sub.kinds.has(r.kind)).map(({ rowid: _, ...r }) => r as MeshRecord)
      if (!mine.length) continue
      try {
        sub.fn(mine)
      } catch (err) {
        console.error(`mesh.adopted listener failed: ${(err as Error).message}`)
      }
    }
  }

  close(): void {
    clearInterval(this.#timer)
    this.#subs.clear()
  }
}
