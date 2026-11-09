/**
 * The module lifecycle: discover -> validate -> register -> start.
 *
 * The staging is the point. Everything that can refuse a module happens BEFORE
 * any module code is imported:
 *
 *   discover   read module.json. No code runs.
 *   validate   schema, version compat, dependency resolution. No code runs.
 *   register   claim tables, mount routes, record capabilities. No code runs.
 *   start      NOW import the module and call start(). First execution.
 *
 * So an incompatible, colliding, cyclic or malformed module is refused without
 * ever having executed. A module failing at `start` is isolated: it is marked
 * failed and reported, and the rest of the system stays up.
 */

import path from 'node:path'
import { pathToFile } from './paths.js'
import { discover, type Rejected } from './discover.js'
import { resolve } from './resolve.js'
import { checkCompat, CORE_VERSION, CONTRACT_VERSION } from './compat.js'
import { createCapabilities, type ModuleCtx, type CortexModule } from './ctx.js'
import { EventBus } from './events.js'
import { Storage } from './storage.js'
import type { Manifest } from './manifest.js'

/** 'host-only': a `runs: host` module in a process that is not the host; its start() is skipped. */
export type ModuleState = 'started' | 'blocked' | 'failed' | 'rejected' | 'host-only'

export type ModuleStatus = {
  name: string
  version?: string
  state: ModuleState
  /** Present for every non-started state. Always human-readable. */
  reason?: string
}

export type LoadedModule = {
  manifest: Manifest
  dir: string
  ctx: ModuleCtx
  impl: CortexModule
}

export type LifecycleResult = {
  started: LoadedModule[]
  statuses: ModuleStatus[]
}

export type LifecycleOptions = {
  modulesDir: string
  dataRoot: string
  dbPath: string
  events: EventBus
  storage: Storage
  log?: (msg: string) => void
  /** This process is the long-running Cortex host, the only place `runs: host` modules start. */
  host?: boolean
  /**
   * With host: start only these `runs: host` modules; the others stay host-only. A short-lived
   * process that needs one (private mind's one-shot sync) must not start the rest (a second
   * telegram poller).
   */
  hostModules?: string[]
}

export class Lifecycle {
  #opts: LifecycleOptions
  #capabilities = createCapabilities()
  #loaded: LoadedModule[] = []
  #statuses: ModuleStatus[] = []

  constructor(opts: LifecycleOptions) {
    this.#opts = opts
  }

  get capabilities() {
    return this.#capabilities
  }
  get statuses(): ModuleStatus[] {
    return [...this.#statuses]
  }
  get started(): LoadedModule[] {
    return [...this.#loaded]
  }

  async run(): Promise<LifecycleResult> {
    const log = this.#opts.log ?? (() => {})

    // ── discover ──────────────────────────────────────────────────────────
    const { found, rejected } = await discover(this.#opts.modulesDir)
    for (const r of rejected) this.#reject(r)

    // ── validate: version compatibility, both directions ──────────────────
    const compatible = found.filter(({ manifest }) => {
      const verdict = checkCompat({
        moduleName: manifest.name,
        requiresCore: manifest.requiresCore,
      })
      if (verdict.ok) return true
      this.#statuses.push({
        name: manifest.name,
        version: manifest.version,
        state: 'blocked',
        reason: verdict.reason,
      })
      return false
    })

    // ── validate: dependency resolution ───────────────────────────────────
    const plan = resolve(compatible.map((c) => c.manifest))
    for (const b of plan.blocked) {
      const m = compatible.find((c) => c.manifest.name === b.name)
      this.#statuses.push({
        name: b.name,
        version: m?.manifest.version,
        state: 'blocked',
        reason: b.reason,
      })
    }
    if (plan.cycles.length) {
      for (const cycle of plan.cycles) log(`[core] dependency cycle refused: ${cycle.join(' -> ')}`)
    }

    // ── register: claim resources. Still no module code executed. ─────────
    const byName = new Map(compatible.map((c) => [c.manifest.name, c]))
    const registered: string[] = []

    for (const name of plan.order) {
      const entry = byName.get(name)
      if (!entry) continue
      const { manifest } = entry

      if (manifest.storage?.use === 'core') {
        const claim = this.#opts.storage.claim({
          module: manifest.name,
          tables: manifest.storage.tables,
          views: manifest.storage.views,
        })
        if (!claim.ok) {
          this.#statuses.push({
            name,
            version: manifest.version,
            state: 'blocked',
            reason: claim.reason,
          })
          continue
        }
      }
      registered.push(name)
    }

    // ── start: import and run. First execution of module code. ────────────
    for (const name of registered) {
      const entry = byName.get(name)!
      const { manifest, dir } = entry
      const hostOnly = manifest.runs === 'host' && (!this.#opts.host || (this.#opts.hostModules !== undefined && !this.#opts.hostModules.includes(name)))
      const ctx: ModuleCtx = {
        name: manifest.name,
        dir,
        db: manifest.storage?.use === 'core' && !hostOnly ? this.#opts.storage.db() : undefined,
        // ALWAYS PROVIDED, and it used to depend on `storage.use`.
        //
        // That coupling was wrong and it produced a silent failure: `storage.use`
        // governs whether core opens a DATABASE for the module, not whether the
        // module is allowed files. Memory uses core storage AND keeps a journal
        // on disk, so it got `undefined` and fell back to
        // `path.join(ctx.dir, 'data')` — the INSTALL directory, i.e. a git
        // checkout, read-only in the lab and on drvfs on a WSL machine.
        //
        // The sweep then threw on every run. Nothing crashed, ingest simply
        // never happened, and the module reported "ready — 0 memories" exactly
        // as it would on an empty corpus. Found only because the ingest driver
        // reports which directories it SKIPPED; a driver that logged only what
        // it swept would have looked idle and correct.
        //
        // Everything WRITTEN comes from the state dir — see core/paths.ts.
        dataDir: path.join(this.#opts.dataRoot, manifest.name),
        events: this.#opts.events,
        capabilities: this.#capabilities,
        core: { version: CORE_VERSION, contract: CONTRACT_VERSION },
        log: (msg) => log(`[${manifest.name}] ${msg}`),
      }

      if (hostOnly) {
        this.#opts.storage.release(name)
        this.#statuses.push({ name, version: manifest.version, state: 'host-only', reason: 'runs only in the Cortex host process' })
        // A handler the module marked outsideHost still runs here, with its ctx and without start().
        for (const sub of manifest.subscribes.filter((x) => x.outsideHost)) {
          try {
            const handlerMod = await import(pathToFile(path.join(dir, sub.handler)))
            const fn = handlerMod.default ?? handlerMod.handler
            if (typeof fn === 'function') this.#opts.events.subscribe(sub.event, manifest.name, (payload) => fn(payload, ctx), sub.order)
          } catch (err) {
            log(`[core] ${name}: handler ${sub.handler} not registered: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        continue
      }

      try {
        const impl = await this.#import(dir, manifest)

        for (const sub of manifest.subscribes) {
          const handlerMod = await import(pathToFile(path.join(dir, sub.handler)))
          const fn = handlerMod.default ?? handlerMod.handler
          if (typeof fn !== 'function') {
            throw new Error(`subscription handler "${sub.handler}" exports no callable default`)
          }
          // THE HANDLER GETS ctx AS ITS SECOND ARGUMENT, and it must.
          //
          // Manifest-declared subscription is the inspectable route — it is what
          // `status` reports and what lets a module register a hook without
          // editing core. But a handler imported by path has no reference to its
          // module's state, so without this the declared route worked ONLY for
          // stateless handlers. Any subscriber needing the database (which is
          // most of the reasons to subscribe at all) would have had to reach
          // back into its own module's internals and depend on start() having
          // already run. That is a load-order coupling nobody would discover
          // until it broke, so core passes the context instead.
          this.#opts.events.subscribe(
            sub.event,
            manifest.name,
            (payload) => fn(payload, ctx),
            sub.order,
          )
        }

        await impl.start?.(ctx)

        this.#loaded.push({ manifest, dir, ctx, impl })
        this.#statuses.push({ name, version: manifest.version, state: 'started' })
      } catch (err) {
        // A module that throws at start is isolated, not fatal. Undo anything
        // it managed to claim so a retry starts from a clean slate.
        this.#opts.events.unsubscribeModule(name)
        this.#capabilities.revoke(name)
        this.#opts.storage.release(name)
        this.#statuses.push({
          name,
          version: manifest.version,
          state: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        })
        log(`[core] module "${name}" failed to start: ${err}`)
      }
    }

    this.#statuses.sort((a, b) => a.name.localeCompare(b.name))
    return { started: this.#loaded, statuses: this.statuses }
  }

  /** Stop in reverse start order, so dependents stop before their dependencies. */
  async stopAll(): Promise<void> {
    const log = this.#opts.log ?? (() => {})
    for (const mod of [...this.#loaded].reverse()) {
      try {
        await mod.impl.stop?.(mod.ctx)
      } catch (err) {
        log(`[core] module "${mod.manifest.name}" threw during stop: ${err}`)
      }
      this.#opts.events.unsubscribeModule(mod.manifest.name)
      this.#capabilities.revoke(mod.manifest.name)
      this.#opts.storage.release(mod.manifest.name)
    }
    this.#loaded = []
  }

  async #import(dir: string, manifest: Manifest): Promise<CortexModule> {
    const entry = pathToFile(path.join(dir, 'server', 'index.ts'))
    const mod = await import(entry)
    const impl = (mod.default ?? mod) as CortexModule
    if (impl.start && typeof impl.start !== 'function') {
      throw new Error(`module "${manifest.name}" exports a non-callable start`)
    }
    return impl
  }

  #reject(r: Rejected): void {
    this.#statuses.push({
      name: r.name,
      state: 'rejected',
      reason: r.errors.join('; '),
    })
  }
}
