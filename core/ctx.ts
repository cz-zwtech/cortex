/**
 * `ctx` — the amenity delivery surface.
 *
 * The dependency rule in one object: a module reaches CORE SERVICES through
 * `ctx`, and reaches OTHER MODULES only through `capabilities`. It never
 * imports another module directly.
 *
 * `db` is deliberately optional in the type. A module that declared
 * `storage: {use: 'self'}` or omitted storage gets `undefined`, and TypeScript
 * makes it check. That is what turns "offered, not required" from a slogan into
 * something the compiler enforces.
 */

import type { EventBus } from './events.js'
import type Database from 'better-sqlite3'

export type Capabilities = {
  /**
   * Look up a capability by id. Returns undefined when the providing module is
   * absent — there is deliberately no throwing variant, because an optional
   * dependency must be checkable without exception handling.
   */
  get<T = unknown>(id: string): T | undefined
  /** Whether a capability is available, for readability at call sites. */
  has(id: string): boolean
  /** Register a capability. Called by core on the declaring module's behalf. */
  provide(id: string, impl: unknown): void
  /** Remove a module's capabilities when it stops. */
  revoke(module: string): void
  /** Everything currently available, for `status`. */
  list(): string[]
}

export type ModuleCtx = {
  /** This module's name — mods should not hardcode their own identity. */
  name: string
  /** Absolute path to the module's own directory. */
  dir: string
  /** Shared database. UNDEFINED unless the mod declared storage.use = 'core'. */
  db?: Database.Database
  /**
   * Private data directory, under the STATE dir. Always present.
   *
   * Independent of `storage.use`: that setting decides whether core opens a
   * database for the module, not whether the module may have files of its own.
   * Memory uses core storage and still keeps a journal on disk.
   */
  dataDir: string
  /** The core message bus. */
  events: EventBus
  /** Other modules' capabilities — optional by construction. */
  capabilities: Capabilities
  /** Core and contract versions, so a mod can adapt rather than guess. */
  core: { version: string; contract: string }
  log: (msg: string) => void
}

/**
 * What a module reports about its own health.
 *
 * Core knows whether a module STARTED. It cannot know whether the module is
 * doing anything useful — that requires domain knowledge core deliberately does
 * not have. A module that started, holds an empty corpus, and has a quarantine
 * nobody has read is "started" by every measure core can take, and broken by
 * every measure that matters.
 */
export type ModuleHealth = {
  /** One line for the ordinary case. */
  summary: string
  /**
   * Things a human should act on. Surfaced prominently, never buried.
   *
   * A warning here is the module saying "I am running and something is wrong",
   * which is precisely the state that has no other way to become visible.
   */
  warnings?: string[]
}

/** A module's default export. Every field is optional: the minimum mod does nothing. */
export type CortexModule = {
  start?: (ctx: ModuleCtx) => void | Promise<void>
  stop?: (ctx: ModuleCtx) => void | Promise<void>
  /** Read-only self-report for `status`. Must not throw and must not mutate. */
  status?: (ctx: ModuleCtx) => ModuleHealth
}

export const createCapabilities = (): Capabilities => {
  const impls = new Map<string, unknown>()

  return {
    get<T>(id: string): T | undefined {
      return impls.get(id) as T | undefined
    },
    has(id) {
      return impls.has(id)
    },
    provide(id, impl) {
      impls.set(id, impl)
    },
    revoke(module) {
      for (const id of [...impls.keys()]) {
        if (id.startsWith(`${module}.`)) impls.delete(id)
      }
    },
    list() {
      return [...impls.keys()].sort()
    },
  }
}
