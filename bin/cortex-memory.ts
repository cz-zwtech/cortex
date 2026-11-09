#!/usr/bin/env tsx
/**
 * `cortex-memory` — the human-facing surface, and the first real consumer of
 * memory's capability API.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO GAPS, ONE FILE
 *
 * 1. A HUMAN HAD NO WAY TO USE ANY OF THIS. Ingest ran on session events, recall
 *    ran on prompts, and neither could be invoked, inspected, or corrected
 *    directly. A memory system you cannot ask a question of is one you cannot
 *    debug, and the first thing anyone does when recall surprises them is want
 *    to run the query by hand.
 *
 * 2. ALL SIX DECLARED CAPABILITIES HAD ZERO CALLERS. `module.json` advertises
 *    them, `/cortex-status` lists them, and nothing invoked a single one —
 *    including memory's own subscribers, which bypass the capability layer and
 *    call the internals directly.
 *
 *    That is defensible as far as it goes: capabilities are the CROSS-MODULE
 *    interop surface and there is only one module. But it left the surface
 *    entirely unexercised while being reported as available, which is the same
 *    declared-but-inert shape this module has now found five times elsewhere.
 *
 * So this goes THROUGH the capabilities rather than around them. It is a real
 * consumer of the contract, and if the contract is wrong this is where it shows.
 */

import { EventBus } from '../core/events.js'
import { machineId } from '../core/machineId.js'
import { Storage } from '../core/storage.js'
import { Lifecycle } from '../core/lifecycle.js'
import { dataRoot, dbPath, modulesDir } from '../core/paths.js'

const USAGE = `cortex-memory — inspect and correct the memory graph

  status                 corpus size, quarantine depth, warnings
  list [n]               most recent memories (default 10)
  show <id|name>         one memory in full
  recall <query…>        run a query the way a prompt would, with the signals
  quarantine             memories held by the secret gate, and why
  unquarantine <hash>    drop a held memory without ingesting it
  release <hash> [why]   mark a held memory a false positive; the next sweep ingests it
  restub [--apply]       give 0-byte files left by the pre-stub sweep the generic stub
  reindex [--apply]      re-read description and kind from the journal for ingested memories
  sweep                  ingest the memory directories now
  capture [--all | --file <transcript>] [--status]
                         session transcripts into the context store (dialogue only; tool output,
                         thinking and hook context dropped; secrets redacted). --status lists
                         transcripts not yet captured and any near Claude Code's cleanup
  consolidate [--dry-run] [--model M] [--effort E] [--batches N] [--stage S[,S…]]
                         background consolidation by a headless model (tools off), checked before
                         applied, recorded per run. Stages: facets, relations (duplicate,
                         contradicts, evolved_into), vocabulary (retire, merge), staleness, lessons,
                         digests (of dialogue spans gone cold)
  consolidate --enable [--model M] [--effort E] | --disable
                         turn the nightly run on or off here (off by default; manual runs always work)
  consolidate --runs | --revert <run>
                         recent runs (tokens, cost, outcome); undo one run whole
  facets [memory]        a memory's facets, or the facet vocabulary with counts
  stale [memory]         memories flagged stale (contradicted, condition lapsed, unconfirmed); never removed
  context search <words…> [-n N]   keyword search over captured dialogue
  context window <block id> [n]    a block with n blocks either side (default 3)
  context why <memory id|name>     the dialogue that produced a memory (its anchors)
  capture --anchors                anchor memories to the dialogue that wrote them, from captured transcripts
  forget <id>            delete one memory
  protect <id> on|off    exempt from decay (or stop exempting)
  take-in [--dir <memory dir>] [--apply]
                         MEMORY.md: take each section's prose in as a memory file (rules headings
                         become standing), then reduce it to the Cortex block plus unresolved
                         pointers. A dry run without --apply; the next sweep ingests the files
  verify [--repair]      memories of this machine in the journal with no graph row (not recallable here);
                         --repair writes them into the graph (after a backup)
  standing list | <id> on|off | seed --from <MEMORY.md> [--section <regex>] [--apply]
                         standing rules load in every session; seed marks the memories an old
                         MEMORY.md indexed under its rules heading (a dry run without --apply)

Read-only unless the verb says otherwise. Every verb goes through the module's
declared capabilities, so this is also the contract's only real consumer.`

const events = new EventBus()
const storage = new Storage(dbPath())
const lifecycle = new Lifecycle({
  modulesDir: modulesDir(),
  dataRoot: dataRoot(),
  dbPath: storage.path,
  events,
  storage,
  log: () => {},
})
// capture and context read and write only the context store: they never start the
// module lifecycle, so a detached catch-up cannot contend with a sweep for the graph.
if (!['capture', 'context'].includes(process.argv[2] ?? '')) await lifecycle.run()

const caps = lifecycle.capabilities
const out: string[] = []
const [verb, ...rest] = process.argv.slice(2)

const die = (msg: string): never => {
  console.error(msg)
  await_exit(1)
  throw new Error(msg)
}
function await_exit(code: number): void {
  void lifecycle.stopAll().then(() => {
    storage.close()
    process.exit(code)
  })
}

const need = <T>(id: string): T => {
  const fn = caps.get<T>(id)
  if (!fn) {
    // Naming the module rather than the capability: a missing capability almost
    // always means the module did not start, and the capability name sends
    // people looking in the wrong place.
    die(`memory is not available (capability "${id}" not provided). Is the module installed and started? Try /cortex-status.`)
  }
  return fn!
}

const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\n/g, ' ')

switch (verb) {
  case undefined:
  case 'help':
  case '--help':
    out.push(USAGE)
    break

  case 'status': {
    const mod = lifecycle.started.find((m) => m.manifest.name === 'memory')
    if (!mod?.impl.status) die('memory is not started')
    const h = mod!.impl.status!(mod!.ctx)
    out.push(h.summary)
    for (const w of h.warnings ?? []) out.push(`⚠ ${w}`)
    break
  }

  case 'list': {
    const n = Number(rest[0] ?? 10)
    if (!Number.isInteger(n) || n < 1) die('usage: cortex-memory list [n]   (n is how many; to find a memory by words use: recall <words>)')
    const search = need<(term: string, limit?: number) => unknown[]>('memory.search')
    // `search('')` is a LIKE on the empty string, which matches everything — the
    // one case where whole-query substring search is exactly what is wanted.
    const rows = search('', n) as { memory?: { id: string; name: string; content: string } }[]
    if (!rows.length) out.push('no memories')
    for (const r of rows) {
      const m = r.memory ?? (r as unknown as { id: string; name: string; content: string })
      out.push(`${m.id}  ${m.name}`)
      out.push(`    ${short(m.content)}`)
    }
    break
  }

  case 'show': {
    const id = rest[0] ?? die('usage: cortex-memory show <id|name>')
    const get = need<(id: string) => unknown>('memory.get')
    // By name too: the standing rules load as one line each, naming the rule, not its id.
    const named = () => {
      const hits = need<{ byName: (n: string) => { id: string }[] }>('memory.standing').byName(id)
      if (hits.length > 1) die(`${hits.length} memories are named ${id}; show one by id: ${hits.map((h) => h.id).join(', ')}`)
      return hits[0] ? get(hits[0].id) : null
    }
    const m = (get(id) ?? named()) as Record<string, unknown> | null
    if (!m) die(`no memory with id or name ${id}`)
    for (const k of ['id', 'name', 'description', 'scope', 'shape', 'pinned', 'protected', 'machine']) {
      out.push(`${k}: ${String(m![k])}`)
    }
    out.push('')
    out.push(String(m!.content))
    break
  }

  case 'recall': {
    const ei = rest.indexOf('--explain')
    const explainTarget = ei >= 0 ? rest[ei + 1] : undefined
    const query = (ei >= 0 ? rest.filter((_, i) => i !== ei && i !== ei + 1) : rest).join(' ')
    if (!query) die('usage: cortex-memory recall <query…> [--explain <id|name>]')
    const { recall } = await import('../modules/memory/server/recall.js')
    const { lexicalSeed } = await import('../modules/memory/server/seed.js')
    const { MemoryStore } = await import('../modules/memory/server/store.js')
    const { indexSubjects, resolveRoles } = await import('../modules/memory/server/subjects.js')
    const { queryTerms } = await import('../modules/memory/server/relevance.js')
    const store = new MemoryStore(storage.db())
    indexSubjects(store)
    const resolved = resolveRoles(store, queryTerms(query))
    const r = recall(query, { store, seeds: [lexicalSeed(store)], asOf: Date.now(), k: 10, resolved, ...(explainTarget ? { explain: explainTarget } : {}) })

    // THE SIGNALS ARE THE POINT OF RUNNING THIS BY HAND. "Why did this surface?"
    // is the question, and a list of results without the scoring answers it no
    // better than the injection did.
    if (r.corpusEmpty) out.push('the graph is empty — nothing has been ingested')
    for (const h of r.hits) {
      out.push(`${h.score.toFixed(3)}  ${h.memory.name}  (${h.memory.id})`)
      const s = h.signals
      out.push(
        `    via ${s.via}${s.relation ? ` ${s.relation}` : ''} hops=${s.hops} ` +
          `sim=${s.similarity?.toFixed(2) ?? 'n/a'} usage=${s.usageBonus.toFixed(2)} ` +
          `edge=${s.edgeBonus.toFixed(2)} recency=${s.recencyBonus.toFixed(2)} ` +
          `scope=${s.scopeBonus} pin=${s.pinBonus} decay=${s.decayPenalty.toFixed(2)}`,
      )
    }
    // Everything the pipeline declined to do, said plainly — the same obligation
    // the injection surfaces carry.
    out.push('')
    out.push(
      `seed: ${r.seed.via}${r.seed.degradedFrom ? ` (degraded from ${r.seed.degradedFrom.kind}: ${r.seed.degradedFrom.reason})` : ''}`,
    )
    out.push(
      `traversal: reached ${r.traversal.reached}, depth ${r.traversal.depthExplored}` +
        `${r.traversal.stoppedByBound ? ', stopped by bound (lossless)' : ''}` +
        `${r.traversal.breadthTruncatedAt.length ? `, breadth capped at ${r.traversal.breadthTruncatedAt.length} node(s) — LOSSY` : ''}`,
    )
    out.push(`cut: ${r.cut.droppedByFloor} below the relevance floor, ${r.cut.droppedByK} past k`)
    if (r.explain) {
      const e = r.explain
      out.push('')
      if (!e.found) out.push(`explain: no memory with id or name "${e.target}"`)
      else {
        const s = e.signals!
        out.push(`explain ${e.target} (${e.id}): ${e.returned ? 'RETURNED' : 'not returned'}`)
        out.push(`  lexical candidate: ${e.seedRank ? `#${e.seedRank}` : 'no (no query word matched it)'}; seeds taken: ${e.seedK}; seeded: ${e.seeded ? 'yes' : 'no'}${e.reachedByEdge ? '; reached by an edge' : ''}`)
        out.push(`  score ${e.score?.toFixed(3)} (rank #${e.rank}): sim=${s.similarity?.toFixed(2) ?? 'n/a'} usage=${s.usageBonus.toFixed(2)} recency=${s.recencyBonus.toFixed(2)} scope=${s.scopeBonus} pin=${s.pinBonus} decay=${s.decayPenalty.toFixed(2)}`)
        if (e.collapsedInto) out.push(`  collapsed behind ${e.collapsedInto} as a near-duplicate`)
        if (e.cutBy) out.push(`  dropped by the cut: ${e.cutBy === 'floor' ? 'below the relevance floor' : 'past k'}`)
      }
    }
    break
  }

  case 'quarantine': {
    const { MemoryStore } = await import('../modules/memory/server/store.js')
    const held = new MemoryStore(storage.db()).quarantined()
    if (!held.length) out.push('nothing quarantined')
    for (const h of held) {
      out.push(`${h.hash.slice(0, 12)}  ${h.source}`)
      // The findings carry kind/line/hint and NEVER the matched value — a
      // review tool that printed the secret would be the leak it exists to
      // prevent, one layer over.
      out.push(`    ${JSON.stringify(h.findings)}`)
    }
    break
  }

  case 'unquarantine': {
    // Drop a held memory without ingesting it: the writer does not want it (release would ingest it).
    const prefix = rest[0] ?? die('usage: cortex-memory unquarantine <hash>')
    const { MemoryStore } = await import('../modules/memory/server/store.js')
    const store = new MemoryStore(storage.db())
    const hits = store.quarantined().filter((h) => h.hash.startsWith(prefix!))
    if (hits.length !== 1) die(hits.length ? `${prefix} matches ${hits.length} held memories; give more of the hash` : `nothing held matches ${prefix}`)
    store.clearDecline(hits[0]!.hash)
    out.push(`dropped ${hits[0]!.hash.slice(0, 12)} (${hits[0]!.source}) from the quarantine; it is not ingested`)
    break
  }

  case 'release': {
    // Per hash, never per rule: releasing one false positive must not open the
    // gate for anything else. The release only clears the decline; the content
    // still reaches the graph through an ordinary sweep, so it is reconciled
    // like any other memory.
    const prefix = rest[0] ?? die('usage: cortex-memory release <hash> [why]')
    const { MemoryStore } = await import('../modules/memory/server/store.js')
    const store = new MemoryStore(storage.db())
    const hits = store.quarantined().filter((h) => h.hash.startsWith(prefix))
    if (hits.length !== 1) die(hits.length ? `${prefix} matches ${hits.length} held memories; give more of the hash` : `nothing held matches ${prefix}`)
    store.release(hits[0]!.hash, rest.slice(1).join(' ') || 'released by hand')
    out.push(`released ${hits[0]!.hash.slice(0, 12)} (${hits[0]!.source}); run "cortex-memory sweep" to ingest it`)
    break
  }

  case 'restub': {
    if (rest.includes('--apply')) {
      const { backupMemory } = await import('../core/backup.js')
      try {
        out.push(`backup: ${backupMemory('restub', (await import('node:path')).resolve(import.meta.dirname, '..')).file}`)
      } catch (err) {
        die(`refused: no restub without a backup (${err instanceof Error ? err.message : String(err)})`)
      }
    }
    // One-off for installs that ran before the stub existed and emptied files
    // to 0 bytes. Only a file the store records as a memory SOURCE is touched:
    // an empty file Cortex never ingested is not ours to explain.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { memoryDirs } = await import('../modules/memory/server/drive.js')
    const { STUB_LINE } = await import('../modules/memory/server/consume.js')
    const { memoryRoots, memoryRootsAreDeclared } = await import('../core/paths.js')
    const apply = rest.includes('--apply')
    const known = storage.db().prepare('SELECT 1 FROM memories WHERE source = ? LIMIT 1')
    let stubbed = 0
    let unknown = 0
    for (const dir of memoryDirs(memoryRoots(), 3, memoryRootsAreDeclared())) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.md') || /^MEMORY(-archive)?\.md$/.test(name)) continue
        const file = path.join(dir, name)
        if (fs.statSync(file).size !== 0) continue
        if (!known.get(file)) {
          unknown++
          continue
        }
        if (apply) fs.writeFileSync(file, STUB_LINE + '\n')
        stubbed++
      }
    }
    out.push(`${apply ? 'stubbed' : 'would stub'} ${stubbed} empty file(s) whose memory is in Cortex`)
    if (unknown) out.push(`left ${unknown} empty file(s) Cortex has no record of`)
    if (!apply) out.push('run with --apply to write the stub')
    break
  }

  case 'reindex': {
    if (rest.includes('--apply')) {
      const { backupMemory } = await import('../core/backup.js')
      try {
        out.push(`backup: ${backupMemory('reindex', (await import('node:path')).resolve(import.meta.dirname, '..')).file}`)
      } catch (err) {
        die(`refused: no reindex without a backup (${err instanceof Error ? err.message : String(err)})`)
      }
    }
    const { MemoryStore } = await import('../modules/memory/server/store.js')
    const { Journal } = await import('../modules/memory/server/journal.js')
    const { reindex } = await import('../modules/memory/server/reindex.js')
    const path = await import('node:path')
    const apply = rest.includes('--apply')
    const journal = new Journal({ dir: path.join(dataRoot(), 'memory', 'journal'), machine: machineId() })
    const r = reindex(new MemoryStore(storage.db()), journal, apply)
    out.push(`${r.checked} checked, ${r.changed} ${apply ? 'updated' : 'would update'} (description and kind from the journal)`)
    if (r.noJournal) out.push(`${r.noJournal} have no journal record and were left as they are`)
    if (!apply) out.push('run with --apply to write')
    break
  }

  case 'verify': {
    const repair = rest.includes('--repair')
    if (repair) {
      const { backupMemory } = await import('../core/backup.js')
      try {
        out.push(`backup: ${backupMemory('verify', (await import('node:path')).resolve(import.meta.dirname, '..')).file}`)
      } catch (err) {
        die(`refused: no repair without a backup (${err instanceof Error ? err.message : String(err)})`)
      }
    }
    const r = need<(o?: { repair?: boolean }) => { checked: number; missing: { seq: number; slug: string; source: string }[]; repaired: string[] }>('memory.verify')({ repair })
    out.push(`${r.checked} memories of this machine checked; ${r.missing.length} in the journal with no graph row${r.missing.length && !repair ? ' (cortex-memory verify --repair writes them in)' : ''}`)
    for (const m of r.missing) out.push(`  seq ${m.seq}  ${m.slug}  (${m.source})`)
    if (repair) out.push(`repaired: ${r.repaired.length}`)
    break
  }

  case 'sweep': {
    const sweep = need<(dir: string, scope?: string) => { ingested: number; declined: number; cleared?: string[]; folded?: { source: string; into: string }[]; appendedTo?: { source: string; into: string }[]; heldAppends?: string[] }>(
      'memory.sweep',
    )
    const { memoryDirs, scopeForDir } = await import('../modules/memory/server/drive.js')
    const { memoryRoots, memoryRootsAreDeclared } = await import('../core/paths.js')
    const dirs = memoryDirs(memoryRoots(), 3, memoryRootsAreDeclared())
    if (!dirs.length) out.push('no memory directories found')
    let ingested = 0
    let declined = 0
    for (const d of dirs) {
      const r = sweep(d, scopeForDir(d))
      ingested += r.ingested
      declined += r.declined
      out.push(`${d}: ${r.ingested} ingested${r.folded?.length ? `, ${r.folded.length} folded` : ''}, ${r.declined} quarantined`)
      for (const f of r.folded ?? []) out.push(`  folded: ${f.source} is already memory ${f.into} (identical text), so nothing new was added`)
      for (const a of r.appendedTo ?? []) out.push(`  updated: text added below the stub in ${a.source} went into memory ${a.into}`)
      for (const h of r.heldAppends ?? []) out.push(`  held: text added below the stub in ${h} names no single memory; see the note in the file`)
      for (const c of r.cleared ?? []) out.push(`  quarantine cleared: ${c} (the file is gone)`)
    }
    const { logSweep } = await import('../modules/memory/server/sweepLog.js')
    const { consumeAllowed } = await import('../core/paths.js')
    const ti = rest.indexOf('--trigger')
    logSweep((await import('node:path')).join(dataRoot(), 'memory'), {
      at: new Date().toISOString(),
      trigger: ti >= 0 && rest[ti + 1] === 'session-end' ? 'session-end' : 'cli',
      dirs: dirs.length,
      ingested,
      declined,
      skipped: [],
      budgetExhausted: false,
      consume: consumeAllowed(),
    })
    break
  }

  case 'consolidate': {
    const path = await import('node:path')
    const { Journal } = await import('../modules/memory/server/journal.js')
    const { MemoryStore } = await import('../modules/memory/server/store.js')
    const { consolidate, revert, DEFAULTS, STAGES } = await import('../modules/memory/server/consolidate/run.js')
    type Stage = (typeof STAGES)[number]
    const { claudeCall } = await import('../modules/memory/server/consolidate/model.js')
    const { ContextStore } = await import('../modules/memory/server/context/store.js')
    const { contextStorePath } = await import('../modules/memory/server/context/hooks.js')
    const store = new MemoryStore(storage.db())
    const journal = new Journal({ dir: path.join(dataRoot(), 'memory', 'journal'), machine: machineId() })
    const arg = (f: string) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined)
    // Scheduled runs are opt-in per machine (27 Oct 2026: the model is chosen by the bake-off first).
    // `--enable [--model M] [--effort E]` turns the nightly job on with that model; `--disable` turns it off.
    const fsMod = await import('node:fs')
    const settingsFile = path.join(dataRoot(), 'memory', 'consolidate.json')
    const settings = (() => {
      try {
        return JSON.parse(fsMod.readFileSync(settingsFile, 'utf-8')) as { enabled?: boolean; model?: string; effort?: string }
      } catch {
        return {} as { enabled?: boolean; model?: string; effort?: string }
      }
    })()
    if (rest.includes('--enable') || rest.includes('--disable')) {
      const next = { ...settings, enabled: rest.includes('--enable'), ...(arg('--model') ? { model: arg('--model') } : {}), ...(arg('--effort') ? { effort: arg('--effort') } : {}) }
      fsMod.mkdirSync(path.dirname(settingsFile), { recursive: true })
      fsMod.writeFileSync(settingsFile, JSON.stringify(next, null, 2))
      out.push(next.enabled ? `scheduled consolidation ON here: nightly, model ${next.model ?? DEFAULTS.model}${next.effort ? `/${next.effort}` : ''}` : 'scheduled consolidation OFF here (manual runs still work)')
      break
    }
    if (rest.includes('--scheduled') && !settings.enabled) {
      out.push('scheduled consolidation is off on this machine (cortex-memory consolidate --enable to turn it on); nothing run')
      break
    }
    if (rest.includes('--runs')) {
      for (const r of store.runs(20)) {
        out.push(`${r.run}  ${new Date(r.at).toISOString().slice(0, 16)}  ${r.stage} ${r.model}${r.effort ? `/${r.effort}` : ''}  ${r.status}: ${r.ops} ops, ${r.rejected} rejected, ${r.batches} batches, ${r.tokens} tokens, $${r.cost_usd.toFixed(3)}${r.note ? `  (${r.note})` : ''}`)
      }
      if (!out.length) out.push('no consolidation runs yet')
    } else if (arg('--revert')) {
      const context = new ContextStore(contextStorePath(path.join(dataRoot(), 'memory')))
      const r = revert(arg('--revert')!, { store, journal, machine: machineId(), context })
      context.close()
      out.push(`reverted ${arg('--revert')}: ${r.edges} edges and ${r.hubs} hubs removed, ${r.restored} removals restored, ${r.memories.length} derived memories forgotten, ${r.digests} digests dropped`)
    } else {
      const stages = arg('--stage')?.split(',') as Stage[] | undefined
      const bad = stages?.filter((x) => !STAGES.includes(x))
      if (bad?.length) die(`unknown stage ${bad.join(', ')}: stages are ${STAGES.join(', ')}`)
      const context = new ContextStore(contextStorePath(path.join(dataRoot(), 'memory')))
      const r = consolidate({
        store,
        journal,
        machine: machineId(),
        call: claudeCall,
        model: arg('--model') ?? settings.model ?? process.env.CKN_CONSOLIDATE_MODEL ?? DEFAULTS.model,
        ...((arg('--effort') ?? settings.effort ?? process.env.CKN_CONSOLIDATE_EFFORT) ? { effort: arg('--effort') ?? settings.effort ?? process.env.CKN_CONSOLIDATE_EFFORT } : {}),
        ...(arg('--batches') ? { maxBatches: Number(arg('--batches')) } : {}),
        ...(stages ? { stages } : {}),
        context,
        dryRun: rest.includes('--dry-run'),
      })
      context.close()
      const per = Object.entries(r.stages).map(([k, v]) => `${k} ${v}`).join(', ')
      out.push(`${rest.includes('--dry-run') ? 'DRY RUN ' : ''}${r.run}: ${r.status}; ${r.ops} operations ${rest.includes('--dry-run') ? 'proposed' : 'applied'}${per ? ` (${per})` : ''}, ${r.rejected} rejected, ${r.batches} batches, ${r.tokens} tokens, $${r.costUsd.toFixed(3)}; ${r.remaining} memories still without facets`)
      for (const e of r.errors.slice(0, 5)) out.push(`  ${e}`)
      if (r.status === 'failed') process.exitCode = 1
    }
    break
  }

  case 'facets': {
    const { MemoryStore } = await import('../modules/memory/server/store.js')
    const store = new MemoryStore(storage.db())
    const target = rest.join(' ')
    if (target) {
      const m = store.get(store.resolveId(target)) ?? store.byName(target).at(-1) ?? die(`no memory with id or name "${target}"`)
      const edges = store.derivedEdges(m.id).filter((e) => e.rel === 'focus' || e.rel === 'about')
      out.push(`${m.name}: ${edges.length ? edges.map((e) => `${e.rel === 'focus' ? '*' : ''}${e.dst.replace(/^facet:/, '')}`).join('  ') : 'no facets yet'}`)
    } else {
      for (const h of store.hubsOfKind('facet')) {
        const n = store.derivedInto(h.id, ['focus', 'about']).length
        const up = store.derivedEdges(h.id).find((e) => e.rel === 'part_of')
        out.push(`${n.toString().padStart(4)}  ${h.name}${up ? `  (part of ${up.dst.replace(/^facet:work:/, '')})` : ''}`)
      }
      if (!out.length) out.push('no facets yet: run cortex-memory consolidate')
    }
    break
  }

  case 'stale': {
    const { MemoryStore } = await import('../modules/memory/server/store.js')
    const store = new MemoryStore(storage.db())
    const target = rest.join(' ')
    const id = target ? (store.get(store.resolveId(target)) ?? store.byName(target).at(-1) ?? die(`no memory with id or name "${target}"`)).id : undefined
    for (const f of store.flags(id)) {
      out.push(`${new Date(f.since).toISOString().slice(0, 10)}  ${f.reason.padEnd(16)}  ${store.get(f.memory)?.name ?? f.memory}${f.detail ? `  (${f.detail})` : ''}`)
    }
    if (!out.length) out.push(target ? 'not flagged' : 'nothing flagged stale')
    break
  }

  case 'capture': {
    const path = await import('node:path')
    const fs = await import('node:fs')
    const { claudeConfigDir } = await import('../core/paths.js')
    const { ContextStore } = await import('../modules/memory/server/context/store.js')
    const { captureAll, captureFile, captureStatus, cleanupHorizonDays } = await import('../modules/memory/server/context/capture.js')
    const { contextStorePath } = await import('../modules/memory/server/context/hooks.js')
    const dataDir = path.join(dataRoot(), 'memory')
    const store = new ContextStore(contextStorePath(dataDir))
    const projects = path.join(claudeConfigDir(), 'projects')
    try {
      const fi = rest.indexOf('--file')
      if (fi >= 0) {
        const file = rest[fi + 1] ?? die('usage: cortex-memory capture --file <transcript.jsonl>')
        const r = captureFile(store, { path: file, session: path.basename(file, '.jsonl') }, machineId())
        out.push(`${file}: ${r.added} parts added${r.skipped ? ` (skipped: ${r.skipped})` : ''}${r.done ? '' : ' (not finished)'}`)
      } else if (rest.includes('--all')) {
        const lock = path.join(dataDir, 'capture.lock')
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(lock, String(process.pid))
        try {
          const t0 = Date.now()
          const { feedFiles } = await import('../modules/memory/server/context/feed.js')
          const { memoryDirs } = await import('../modules/memory/server/drive.js')
          const { memoryRoots, memoryRootsAreDeclared } = await import('../core/paths.js')
          const r = captureAll(store, projects, machineId(), { feeds: feedFiles(modulesDir(), dataRoot()), memoryDirs: memoryDirs(memoryRoots(), 3, memoryRootsAreDeclared()) })
          const added = r.results.reduce((n, x) => n + x.added, 0)
          out.push(`${new Date().toISOString()} capture --all${rest.includes('--trigger') ? ` (${rest[rest.indexOf('--trigger') + 1]})` : ''}: ${r.results.length} of ${r.pending} files read, ${added} parts added, ${Date.now() - t0} ms`)
        } finally {
          fs.rmSync(lock, { force: true })
        }
      }
      if (rest.includes('--anchors')) {
        const { backfillAnchors } = await import('../modules/memory/server/context/capture.js')
        const { memoryDirs } = await import('../modules/memory/server/drive.js')
        const { memoryRoots, memoryRootsAreDeclared } = await import('../core/paths.js')
        const r = backfillAnchors(store, projects, machineId(), memoryDirs(memoryRoots(), 3, memoryRootsAreDeclared()))
        out.push(`anchors backfilled: ${r.anchors} new, from ${r.files} captured transcripts`)
      }
      if (rest.includes('--status') || (!rest.includes('--all') && !rest.includes('--anchors') && fi < 0)) {
        const s = captureStatus(store, projects, cleanupHorizonDays(claudeConfigDir()))
        const c = store.counts()
        out.push(`context store: ${c.sessions} sessions, ${c.blocks} blocks, from ${c.files} transcript files`)
        out.push(`transcripts: ${s.files}; captured ${s.complete}, skipped (headless) ${s.skipped}, not yet captured ${s.incomplete.length}; cleanup after ${s.horizonDays} days`)
        for (const i of s.incomplete.slice(0, 10)) out.push(`  behind ${i.behind} bytes: ${i.path}`)
        for (const a of s.atRisk) out.push(`  AT RISK, ${a.daysLeft} days to cleanup: ${a.path}`)
      }
    } finally {
      store.close()
    }
    break
  }

  case 'context': {
    const path = await import('node:path')
    const { ContextStore } = await import('../modules/memory/server/context/store.js')
    const { contextStorePath } = await import('../modules/memory/server/context/hooks.js')
    const store = new ContextStore(contextStorePath(path.join(dataRoot(), 'memory')))
    try {
      const [sub, ...args] = rest
      if (sub === 'search') {
        const ni = args.indexOf('-n')
        const n = ni >= 0 ? Number(args[ni + 1]) || 10 : 10
        const words = (ni >= 0 ? args.filter((_, i) => i !== ni && i !== ni + 1) : args).join(' ')
        if (!words) die('usage: cortex-memory context search <words…> [-n N]')
        for (const b of store.search(words, n)) out.push(`#${b.id}  ${new Date(b.at).toISOString().slice(0, 16)}  ${b.session.slice(0, 8)} ${b.speaker}: ${short(b.text, 110)}`)
        for (const d of store.searchDigests(words, 3)) out.push(`digest ${d.span}: ${short(d.summary, 140)}`)
        if (!out.length) out.push('no matches')
      } else if (sub === 'window') {
        const id = Number(args[0]) || die('usage: cortex-memory context window <block id> [n]')
        for (const b of store.windowAcross(id, Number(args[1]) || 3))
          out.push(`${b.id === id ? '>' : ' '} #${b.id} ${b.source === 'transcript' ? '' : `[${b.source}] `}${b.party ?? b.speaker}${b.boundary ? ' (after a compaction)' : ''}: ${b.text}`)
      } else if (sub === 'why') {
        // The dialogue that produced a memory: its anchors, by the file it was written to.
        const target = args.join(' ') || die('usage: cortex-memory context why <memory id|name>')
        const { MemoryStore } = await import('../modules/memory/server/store.js')
        const mem = new MemoryStore(storage.db())
        const m = mem.get(mem.resolveId(target)) ?? mem.byName(target).at(-1) ?? die(`no memory with id or name "${target}"`)
        const anchors = store.anchorsFor(m.source)
        if (!anchors.length) out.push(`${m.name}: no captured dialogue is anchored to it (written before capture began, by another machine, or not in a session)`)
        for (const a of anchors.slice(0, 3)) {
          out.push(`${m.name}: written ${new Date(a.at).toISOString().slice(0, 16)} in session ${a.session.slice(0, 8)} (${a.how}); the dialogue before it:`)
          for (const b of store.anchoredBlocks(a)) out.push(`  #${b.id} ${b.party ?? b.speaker}: ${short(b.text, 400)}`)
        }
      } else die('usage: cortex-memory context search <words…> | window <block id> [n] | why <memory>')
    } finally {
      store.close()
    }
    break
  }

  case 'forget': {
    const id = rest[0] ?? die('usage: cortex-memory forget <id>')
    const del = need<(id: string) => Promise<boolean>>('memory.delete')
    out.push((await del(id)) ? `deleted ${id}` : `no memory with id ${id}`)
    break
  }

  case 'take-in': {
    const { planTakeIn, applyTakeIn } = await import('../modules/memory/server/memoryIndex.js')
    const di = rest.indexOf('--dir')
    let dirs: string[]
    if (di >= 0) dirs = [rest[di + 1]!]
    else {
      const { memoryDirs } = await import('../modules/memory/server/drive.js')
      const { memoryRoots, memoryRootsAreDeclared } = await import('../core/paths.js')
      dirs = memoryDirs(memoryRoots(), 3, memoryRootsAreDeclared())
    }
    const apply = rest.includes('--apply')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let any = false
    for (const d of dirs) {
      const plan = planTakeIn(d)
      if (!plan || (!plan.takeIn.length && !plan.stale)) continue
      any = true
      out.push(`${d}/MEMORY.md${apply ? '' : ' (dry run: add --apply)'}`)
      for (const t of plan.takeIn) out.push(`  take in "${t.heading || '(top)'}": ${t.lines} line(s) -> ${t.file.split('/').pop()}${t.standing ? ' (standing)' : ''}`)
      out.push(`  drop ${plan.stale} pointer(s) whose memory is in Cortex; keep ${plan.unresolved.length} unresolved`)
      for (const u of plan.unresolved) out.push(`    ${u.line}  (${u.reason})`)
      if (apply) {
        const r = applyTakeIn(d, plan, stamp)
        out.push(`  wrote ${r.written.length} file(s); backup ${r.backup}`)
        if (r.skipped.length) out.push(`  NOT REDUCED: a file already exists: ${r.skipped.join(', ')}`)
      }
    }
    if (!any) out.push('no MEMORY.md has anything to take in')
    else if (apply) out.push('run cortex-memory sweep to ingest the new files')
    break
  }

  case 'standing': {
    type Standing = { set: (id: string, v: boolean) => boolean; list: () => { id: string; name: string; description: string }[]; byName: (n: string) => { id: string; name: string }[] }
    const st = need<Standing>('memory.standing')
    const sub = rest[0]
    if (!sub || sub === 'list') {
      const all = st.list()
      out.push(`${all.length} standing rule(s), loaded in every session:`)
      for (const m of all) out.push(`  ${m.id}  ${m.description || m.name}`)
      break
    }
    if (sub === 'seed') {
      const fi = rest.indexOf('--from')
      const from = fi >= 0 ? rest[fi + 1] : undefined
      if (!from) die('usage: cortex-memory standing seed --from <MEMORY.md> [--section <regex>] [--apply]')
      const si = rest.indexOf('--section')
      const section = new RegExp(si >= 0 ? rest[si + 1]! : 'standing|rule', 'i')
      const fs = await import('node:fs')
      const path = await import('node:path')
      let heading = ''
      const picked: { name: string; ids: string[] }[] = []
      for (const line of fs.readFileSync(from!, 'utf-8').split('\n')) {
        const h = /^#{1,6}\s+(.*)$/.exec(line)
        if (h) {
          heading = h[1]!
          continue
        }
        const link = /^\s*[-*]\s+\[[^\]]*\]\(([^)\s]+\.md)\)/.exec(line)
        if (!link || !section.test(heading)) continue
        const name = path.basename(link[1]!, '.md')
        picked.push({ name, ids: st.byName(name).map((m) => m.id) })
      }
      const apply = rest.includes('--apply')
      out.push(`${picked.length} index line(s) under a heading matching /${section.source}/i in ${from}${apply ? '' : ' (dry run: add --apply to mark them)'}`)
      for (const p of picked) {
        if (!p.ids.length) out.push(`  NOT FOUND in memory: ${p.name}`)
        for (const id of p.ids) {
          if (apply) st.set(id, true)
          out.push(`  ${apply ? 'marked' : 'would mark'} ${id}`)
        }
      }
      break
    }
    const mode = rest[1]
    if (mode !== 'on' && mode !== 'off') die('usage: cortex-memory standing list | <id> on|off | seed --from <MEMORY.md> [--apply]')
    out.push(st.set(sub, mode === 'on') ? `${sub} standing=${mode}` : `no memory with id ${sub}`)
    break
  }

  case 'protect': {
    const id = rest[0] ?? die('usage: cortex-memory protect <id> on|off')
    const mode = rest[1]
    if (mode !== 'on' && mode !== 'off') die('usage: cortex-memory protect <id> on|off')
    const protect = need<(id: string, v: boolean) => boolean>('memory.protect')
    out.push(protect(id, mode === 'on') ? `${id} protected=${mode}` : `no memory with id ${id}`)
    break
  }

  default:
    out.push(`unknown verb "${verb}"`)
    out.push('')
    out.push(USAGE)
}

await lifecycle.stopAll()
storage.close()
console.log(out.join('\n'))
