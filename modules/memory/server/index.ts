/**
 * The memory module.
 *
 * Non-lifecycle scope only: this module subscribes to NO lifecycle events yet.
 * Memory owns four of seven hooks in V1, and building those subscribers against
 * a dispatcher that has never run under a real harness would mean proving them
 * with in-process publishes — the degenerate proof already caught once in this
 * project. They land after the harness UAT.
 */

import path from 'node:path'
import { machineId } from '../../../core/machineId.js'
import { claudeConfigDir, consumeAllowed } from '../../../core/paths.js'
import { writeRulesMd } from './rules.js'
import { firstSweepBackedUp } from './firstSweep.js'
import { lastSweep } from './sweepLog.js'
import type { CortexModule, ModuleCtx } from '../../../core/ctx.js'
import { collapseThenTake, type Candidate } from './collapse.js'
import { reconcileRedactions } from './epoch.js'
import { Journal, type VersionVector } from './journal.js'
import { publishCaptured } from './captured.js'
import { ContextStore } from './context/store.js'
import { contextStorePath } from './context/hooks.js'
import { registerClassifier, type Classifier } from './classify.js'
import { adoptRecords } from './ingest.js'
import { MemoryStore, hashContent, type MemoryInput } from './store.js'
import { indexSubjects } from './subjects.js'
import { frontmatterOf } from './frontmatter.js'
import { sweep } from './sweep.js'
import { verify } from './verify.js'
import { MEMORY_UPSERTED, MEMORY_DELETED } from './types.js'

let store: MemoryStore | null = null
let journal: Journal | null = null

/** The file the user's CLAUDE.md imports (core's import block, `claudeImports`). */
const rulesFile = () => path.join(claudeConfigDir(), 'cortex', 'rules.md')

const mod: CortexModule = {
  start(ctx: ModuleCtx) {
    if (!ctx.db) {
      // Declared storage.use = 'core', so this cannot happen — but failing
      // loudly beats a module that silently does nothing, which is the shape
      // that looks healthy in `status` while storing not one memory.
      throw new Error('memory requires the core storage amenity but ctx.db is absent')
    }

    MemoryStore.applySchema(ctx.db)
    store = new MemoryStore(ctx.db)

    // The journal lives in the module's own data dir, which resolves from the
    // STATE dir rather than the install — deriving it from CKN_HOME would put
    // it inside a git checkout, and on the WSL box on a filesystem that cannot
    // provide the fsync semantics its durability rests on.
    journal = new Journal({
      dir: path.join(ctx.dataDir, 'journal'),
      machine: machineId(),
    })

    // BOOT RECONCILIATION, before anything can read the graph. A restore that
    // skipped its procedure converges here rather than silently un-redacting,
    // which is the whole reason enforcement is at boot and not at restore.
    const repaired = reconcileRedactions(journal, store)
    if (repaired.journalRemoved || repaired.graphRemoved) {
      ctx.log(
        `redaction replay: removed ${repaired.journalRemoved} journal record(s) ` +
          `and ${repaired.graphRemoved} memor(ies) — epoch ${repaired.from} → ${repaired.to}`,
      )
    }

    const integrity = journal.integrity()
    if (integrity.length) {
      // Mid-segment corruption. Loud, because the alternative is a disk quietly
      // eating memories while everything reports healthy.
      ctx.log(`JOURNAL INTEGRITY: ${integrity.length} damaged record(s)`)
      for (const e of integrity) ctx.log(`  ${e.segment}:${e.line} — ${e.reason}`)
    }

    // ── capabilities ────────────────────────────────────────────────────────
    // Every write goes through `record`. There is deliberately no second door:
    // a writer that bypasses the canonical upsert loses every downstream pass,
    // which is exactly how V1's onboarding corpus ended up with zero embeddings.

    ctx.capabilities.provide('memory.record', async (input: MemoryInput) => {
      const s = store!
      const contentHash =
        input.contentHash ?? hashContent(input.name, input.description, input.content)
      const outcome = s.upsert({ ...input, contentHash })

      if (outcome.result !== 'unchanged') {
        await ctx.events.publish(MEMORY_UPSERTED, {
          id: outcome.id,
          source: input.source,
          contentHash,
          at: Date.now(),
        })
      }
      return outcome
    })

    ctx.capabilities.provide('memory.get', (id: string) => store!.get(id))

    /**
     * Search, with near-duplicates COLLAPSED BEFORE the cut.
     *
     * Cut-then-collapse is the degenerate composition — three variants of one
     * fact fill the top three slots, the collapse leaves one result, and the two
     * genuinely different memories that should have ranked second and third were
     * already discarded. `collapseThenTake` exists so this cannot be composed
     * the other way by accident.
     */
    ctx.capabilities.provide('memory.search', (term: string, limit = 20) => {
      // Over-fetch deliberately: collapse removes rows, so asking for exactly
      // `limit` would return fewer than requested whenever anything collapsed.
      const raw = store!.search(term, limit * 4)
      const candidates: Candidate[] = raw.map((m, i) => ({ memory: m, score: 1 - i / raw.length }))
      return collapseThenTake(candidates, limit)
    })

    /**
     * Run the scratchpad sweep: the memory dir in, the graph out.
     *
     * Exposed as a capability rather than run on a timer here. Scheduling is a
     * lifecycle concern, and memory's lifecycle subscribers are parked until the
     * dispatcher survives a real harness UAT.
     */
    // rules.md follows the rule memories: written when its text changes, after anything that can change them.
    const refreshRules = () => {
      try {
        writeRulesMd(rulesFile(), store!.rules())
      } catch (err) {
        ctx.log(`rules.md not written: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    refreshRules()
    // The whole first pass of the subject tables happens here, off any hook's budget.
    try {
      const n = indexSubjects(store!)
      if (n) ctx.log(`subjects: read people and titles from ${n} memories`)
    } catch (err) {
      ctx.log(`subject index not built: ${err instanceof Error ? err.message : String(err)}`)
    }
    ctx.capabilities.provide('memory.rules', { list: () => store!.rules(), refresh: refreshRules, exists: (link: string) => store!.hasMemoryNamed(link) })

    ctx.capabilities.provide('memory.sweep', (memoryDir: string, scope = 'user') => {
      const r = sweep(
        { memoryDir, scope, machine: machineId(), consume: consumeAllowed() && firstSweepBackedUp(ctx.dataDir, ctx.log) },
        { store: store!, journal: journal!, onIngested: publishCaptured(ctx) },
      )
      if (r.ingested) refreshRules()
      return r
    })

    // Journal records of this machine the graph lacks (cortex-memory verify); repair writes them in.
    ctx.capabilities.provide('memory.verify', (opts?: { repair?: boolean }) => {
      const r = verify(store!, journal!, machineId(), opts)
      if (r.repaired.length) refreshRules()
      return r
    })

    // ── replication seams (private mind, design 3.1). Generic: memory never syncs by itself. ──
    ctx.capabilities.provide('memory.versionVector', () => journal!.versionVector())
    ctx.capabilities.provide('memory.journalStream', (since: VersionVector = {}) => [...journal!.stream(since)])
    ctx.capabilities.provide('memory.journalAdopt', (records: unknown[]) => {
      const r = adoptRecords(records, { store: store!, journal: journal! })
      if (r.materialized.length || r.removed) refreshRules()
      return r
    })
    ctx.capabilities.provide('memory.classifier', (fn: Classifier) => registerClassifier(fn))
    const withContext = <T>(fn: (c: ContextStore) => T): T => {
      const c = new ContextStore(contextStorePath(ctx.dataDir))
      try {
        return fn(c)
      } finally {
        c.close()
      }
    }
    ctx.capabilities.provide('memory.blockVector', () => withContext((c) => c.blockVector()))
    ctx.capabilities.provide('memory.blockStream', (since: Record<string, number> = {}, limit?: number) => withContext((c) => c.streamBlocks(since, limit)))
    ctx.capabilities.provide('memory.blockAdopt', (blocks: unknown[]) => withContext((c) => c.adoptBlocks(blocks, machineId())))
    ctx.capabilities.provide('memory.shapeOf', (content: string) => frontmatterOf(content).shape)
    ctx.capabilities.provide('memory.sessionInfo', (session: string) => withContext((c) => c.sessionInfo(machineId(), session)))

    // Deletion emits its own event from day one. V1's tombstone origination was
    // never wired — `memMesh` accepts a deletedAt and its only caller never
    // passes one — so deleting a memory on one machine silently returned it
    // from another. An upsert-only vocabulary rebuilds that gap behind a
    // cleaner architecture, where it is HARDER to notice.
    ctx.capabilities.provide('memory.delete', async (id: string) => {
      const s = store!
      const existing = s.get(id)
      if (!existing) return false

      // DELETION THAT A REBUILD UNDOES IS NOT DELETION.
      //
      // The journal is the source of truth and the graph is a derived view, so
      // removing from the graph alone leaves the record intact — and
      // `journal.replay()` exists precisely to rebuild the graph from it. The
      // memory would come back, from a verb the CLI calls `forget`.
      //
      // The append-only-correct answer is a tombstone, and `appendTombstone`
      // already existed with no caller. It is appended BEFORE the graph write:
      // a crash between the two leaves a durable deletion the next boot honours,
      // whereas the other order leaves a graph that has forgotten and a journal
      // that has not.
      // Target the JOURNAL's hash, via the pointer stored at ingest. Using this
      // row's own `content_hash` would silently match nothing: the journal hashes
      // the full text including frontmatter, this table hashes
      // name + description + body. Two hashes, same name, different questions —
      // the trap this module has now hit five times.
      const journalHash = s.journalHashOf(id)
      if (journalHash) {
        journal!.appendTombstone({
          memoryId: id,
          targetHash: journalHash,
          machine: machineId(),
        })
      } else {
        // No local durable record — an adopted row, or one written before the
        // pointer existed. Said rather than silently skipped: the graph row goes,
        // and a rebuild from a peer's journal could legitimately bring it back.
        ctx.log(`delete ${id}: no journal pointer, so this is a graph-only removal`)
      }

      s.deleteCascade(id)
      refreshRules()
      await ctx.events.publish(MEMORY_DELETED, {
        id,
        source: existing.source,
        at: Date.now(),
      })
      return true
    })

    // The generic decay-exemption flag. Personality writes it for engagement
    // directives; memory neither knows nor cares why it is set.
    ctx.capabilities.provide('memory.protect', (id: string, value: boolean) =>
      store!.setProtected(id, value),
    )
    // Standing rules: loaded in every session ahead of the ranked picks.
    ctx.capabilities.provide('memory.standing', {
      set: (id: string, value: boolean) => store!.setStanding(id, value),
      list: () => store!.standing(),
      byName: (name: string) => store!.byName(name),
    })

    ctx.log(`ready — ${store.count()} memories`)
  },

  /**
   * Memory's self-report — the thing core cannot compute for us.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * THE QUARANTINE DEPTH IS THE POINT, AND IT WAS A DESIGN REQUIREMENT NOBODY
   * WIRED
   *
   * `secrets.ts` states it plainly: a noisy quarantine stops being read, and
   * once it does, real secrets sit unsynced in scratchpads and so does
   * EVERYTHING CAUGHT ALONGSIDE THEM — so the user's memory silently stops
   * working and nothing reports it. Its stated mitigation is "surface the
   * quarantine depth in status".
   *
   * That mitigation did not exist. `store.quarantined()` was written and had no
   * caller, so the failure mode the design identified was, until now,
   * unmitigated — the safeguard was designed, built one layer down, and never
   * connected.
   *
   * Read-only and must not throw: `status` is what people run when something is
   * already wrong, which is the worst possible moment for it to fail.
   */
  status(ctx) {
    const s = store
    if (!s) return { summary: 'not started' }
    const last = lastSweep(ctx.dataDir)

    const count = s.count()
    const held = s.quarantined()
    const warnings: string[] = []
    if (last?.skipped.length) {
      warnings.push(`the last sweep (${last.trigger}, ${last.at}) ran out of time and skipped ${last.skipped.length} director(ies): ${last.skipped.slice(0, 3).join(', ')}`)
    }
    if (last && !last.consume) warnings.push(`the last sweep (${last.trigger}, ${last.at}) did not stub files (a backup or state-dir guard held it)`)

    if (held.length) {
      warnings.push(
        `${held.length} memor(ies) QUARANTINED and not in the graph — they are held in their ` +
          `scratchpad files awaiting review. Anything written alongside them is also unsynced. ` +
          `Sources: ${[...new Set(held.map((h) => h.source))].slice(0, 5).join(', ')}`,
      )
    }

    // An empty corpus on a machine that has been running is not obviously a
    // fault — but it IS the state in which every downstream feature silently
    // answers "nothing found", so it is said rather than left to be inferred.
    if (count === 0) {
      warnings.push('the graph holds no memories — recall and dedupe will find nothing')
    }

    const damaged = journal?.integrity() ?? []
    if (damaged.length) {
      warnings.push(`JOURNAL INTEGRITY: ${damaged.length} damaged record(s)`)
    }

    return {
      summary: `${count} memor${count === 1 ? 'y' : 'ies'}, ${held.length} quarantined${last ? `; last sweep ${last.trigger} at ${last.at.slice(0, 16)}Z` : ''}`,
      warnings,
    }
  },

  stop() {
    store = null
    journal = null
  },
}

export default mod
