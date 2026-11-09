/**
 * Storage — a core amenity, offered and declinable.
 *
 * The brief: "the db is a scaffold-level AVAILABLE database, but not a requirement
 * for mods to leverage… or a mod could bring its own database if it deems
 * necessary."
 *
 * Two properties this file exists to guarantee:
 *
 *  1. ZERO OVERHEAD WHEN UNUSED. A naked scaffold opens no database. The handle
 *     is created lazily on first `db()` call, which only happens if a mod
 *     declared `storage.use = 'core'`. This is what makes core-only boot honest
 *     rather than nominal.
 *  2. TABLE OWNERSHIP IS ENFORCED. Mods declare the tables they own; core
 *     refuses a mod that claims a table another mod already owns. V1's single
 *     biggest structural defect was one table with two owners (session_meta),
 *     discovered years later. Making that impossible is cheap here and
 *     expensive anywhere else.
 */

import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

export type TableClaim = { module: string; tables: string[]; views: string[] }

export type ClaimResult = { ok: true } | { ok: false; reason: string }

export class Storage {
  #db: Database.Database | null = null
  #dbPath: string
  /** table name -> owning module */
  #owners = new Map<string, string>()
  /** view name -> declaring module (views may read tables they do not own) */
  #views = new Map<string, string>()

  constructor(dbPath: string) {
    this.#dbPath = dbPath
  }

  get path(): string {
    return this.#dbPath
  }

  /** True once something has actually asked for a connection. */
  get opened(): boolean {
    return this.#db !== null
  }

  /**
   * Claim tables for a module. Called at REGISTER time, before any module code
   * runs, so a collision is refused without executing either mod.
   */
  claim(claim: TableClaim): ClaimResult {
    for (const table of claim.tables) {
      const owner = this.#owners.get(table)
      if (owner && owner !== claim.module) {
        return {
          ok: false,
          reason: `table "${table}" is already owned by module "${owner}"`,
        }
      }
    }
    for (const view of claim.views) {
      const owner = this.#views.get(view)
      if (owner && owner !== claim.module) {
        return { ok: false, reason: `view "${view}" is already declared by module "${owner}"` }
      }
      if (this.#owners.has(view)) {
        return { ok: false, reason: `view "${view}" collides with a table of the same name` }
      }
    }

    for (const table of claim.tables) this.#owners.set(table, claim.module)
    for (const view of claim.views) this.#views.set(view, claim.module)
    return { ok: true }
  }

  /** Release a module's claims when it stops or is uninstalled. */
  release(module: string): void {
    for (const [table, owner] of [...this.#owners]) {
      if (owner === module) this.#owners.delete(table)
    }
    for (const [view, owner] of [...this.#views]) {
      if (owner === module) this.#views.delete(view)
    }
  }

  /** Who owns this table, if anyone. */
  ownerOf(table: string): string | undefined {
    return this.#owners.get(table)
  }

  /**
   * The connection. Opened lazily — calling this is what makes the scaffold
   * stop being storage-free, so nothing in core calls it during boot.
   */
  db(): Database.Database {
    if (!this.#db) {
      fs.mkdirSync(path.dirname(this.#dbPath), { recursive: true })
      this.#db = new Database(this.#dbPath)
      this.#db.pragma('journal_mode = WAL')
      this.#db.pragma('busy_timeout = 5000')
      this.#db.pragma('synchronous = NORMAL')
    }
    return this.#db
  }

  close(): void {
    if (!this.#db) return
    try {
      this.#db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* checkpoint is best-effort; closing matters more */
    }
    this.#db.close()
    this.#db = null
  }
}
