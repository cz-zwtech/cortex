/**
 * SessionStart / SessionEnd — memory's ingest driver, attached to the lifecycle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO EVENTS, TWO DIFFERENT JOBS, AND THE ASYMMETRY IS DELIBERATE
 *
 *   SessionEnd    sweep. Capture what this session wrote, while nobody waits.
 *   SessionStart  sweep FIRST, then recall. Pick up anything written since the
 *                 last end — including by a session that crashed, or by a hand
 *                 edit made with no session running at all.
 *
 * Sweeping at start as well as end is not redundancy for its own sake. A memory
 * written by a session that never reached SessionEnd would otherwise sit
 * un-ingested indefinitely, and the failure is invisible: recall simply does not
 * return it, which is indistinguishable from it not existing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUDGET IS TIGHTER AT START THAN AT END, BECAUSE A HUMAN IS WAITING
 *
 * SessionEnd can afford the work; SessionStart is in front of a person. So start
 * gets a smaller budget and reports what it skipped — and, importantly, RECALL
 * STILL RUNS on a partial sweep, saying so, rather than blocking on a complete
 * one. An injection that is late is worth less than an injection that is
 * incomplete-but-labelled.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { machineId } from '../../../core/machineId.js'
import path from 'node:path'

import type { ModuleCtx } from '../../../core/ctx.js'
import { injectsInto } from './headless.js'
import { firstSweepBackedUp } from './firstSweep.js'
import { logSweep } from './sweepLog.js'
import { memoryRoots, consumeAllowed, memoryRootsAreDeclared, underTest } from '../../../core/paths.js'
import { Journal } from './journal.js'
import { MemoryStore } from './store.js'
import { drive, describeDrive, type DriveReport } from './drive.js'
import { buildSessionContext } from './sessionContext.js'
import { recordSurfacing } from './surfacing.js'
import { activeSubjects, loadPrivacy, renderActiveSubjects } from './constraints.js'
import { indexSubjects } from './subjects.js'
import { buildRestore } from './restore.js'

/** Start is in front of a human; end is not. */
/**
 * The last line of the start block: how much was loaded, and how to get the rest.
 * Generic on purpose; it names no memory, only the way to ask.
 */
export const recallHint = (loaded: number, total: number): string =>
  `${loaded} of ${total} memories loaded; use /cortex-memory recall <words> for the rest, ` +
  'then /cortex-memory show <id> on a hit. Before asking the user a fact (a name, a role, a date, a decision), ' +
  'recall it first. Memory files holding only the cortex:stub line are pointers, not memories.'


export const START_BUDGET_MS = 1_200
export const END_BUDGET_MS = 5_000

export type SessionPayload = { session_id?: string; source?: string; cwd?: string }

export const runIngest = (
  ctx: ModuleCtx,
  budgetMs: number,
  sessionId?: string,
  trigger: 'session-start' | 'session-end' = 'session-start',
): DriveReport | undefined => {
  if (!ctx.db) return undefined
  const consume = consumeAllowed() && firstSweepBackedUp(ctx.dataDir, ctx.log)

  const journal = new Journal({
    dir: path.join(ctx.dataDir, 'journal'),
    machine: machineId(),
  })

  const report = drive(
    {
      roots: memoryRoots(),
      trustRoots: memoryRootsAreDeclared(),
      consume,
      machine: machineId(),
      sessionId,
      budgetMs,
    },
    { store: new MemoryStore(ctx.db), journal },
  )

  // For the status line, which must not open the database on every render.
  try {
    fs.writeFileSync(path.join(ctx.dataDir, 'count'), String(new MemoryStore(ctx.db).countRecallable()))
  } catch {
    /* a missing count shows as "?", never as a failed session */
  }

  // Logged whenever anything happened OR anything was skipped. A silent driver
  // and an absent one are the same from outside, which is the shape this whole
  // module keeps paying for.
  logSweep(ctx.dataDir, {
    at: new Date().toISOString(),
    trigger,
    dirs: report.swept.length,
    ingested: report.ingested,
    declined: report.declined,
    skipped: report.skipped,
    budgetExhausted: report.budgetExhausted,
    consume,
  })
  if (report.ingested || report.declined || report.skipped.length) {
    ctx.log(describeDrive(report))
  }
  return report
}

/**
 * Why there are two handler files rather than one that branches.
 *
 * A subscriber is invoked as `(payload, ctx)` and is NOT told which event it is
 * serving. The first version of this file registered one handler for both events
 * and carried a comment claiming "the budget is chosen by which registration
 * invoked us" — which is simply false: both would have received the start
 * budget, and the comment would have kept anyone from noticing.
 *
 * `hook_event_name` does appear on the harness payload and could be branched on.
 * That is an assumption about a field's presence in a shape we do not own, for
 * no benefit over two three-line files.
 *
 * So: `on-session-start.ts` and `on-session-end.ts`, each passing its own
 * budget. Prefer the version that cannot be built wrong over the version
 * documented as wrong-if-built-that-way — and a comment asserting behaviour the
 * code does not have is worse than no comment, because it survives review.
 */
/** Who and what is in play, with what not to do about them (constraints.ts activeSubjects). */
const activeBlock = (ctx: ModuleCtx, p: SessionPayload): string => {
  try {
    const store = new MemoryStore(ctx.db!)
    indexSubjects(store, { limit: 500, deadline: Date.now() + 200 })
    return renderActiveSubjects(
      activeSubjects(store, { cwd: p.cwd, machine: [machineId(), os.hostname()], privacy: loadPrivacy(ctx.dataDir), asOf: Date.now() }),
    )
  } catch (err) {
    ctx.log(`active subjects skipped: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

/** Only after a compaction: what this session wrote, used and was shown (restore.ts). */
export const restoreBlock = (ctx: ModuleCtx, p: SessionPayload): string => {
  if (p.source !== 'compact' || !p.session_id) return ''
  try {
    return buildRestore(new MemoryStore(ctx.db!), ctx.dataDir, p.session_id)
  } catch (err) {
    ctx.log(`session restore skipped: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

export const onSessionStart = (payload: unknown, ctx?: ModuleCtx) => {
  if (!ctx?.db) return undefined
  const sessionId = ((payload ?? {}) as SessionPayload).session_id

  // SWEEP FIRST, THEN RECALL. Injecting before ingesting would surface a corpus
  // that is one session out of date, every session — and the staleness would be
  // invisible, because a memory written last session and not yet ingested is
  // indistinguishable from one that was never written.
  ingestGuarded(payload, ctx, START_BUDGET_MS)
  if (!injectsInto()) return undefined

  try {
    const built = buildSessionContext({
      store: new MemoryStore(ctx.db),
      asOf: Date.now(),
    })

    // The empty-corpus case is reported to the OPERATOR and contributes nothing
    // to the model. Telling a session "I have no memories" every start would
    // spend another module's injection budget on our own incompleteness.
    if (built.corpusEmpty) {
      ctx.log('session context: graph is empty, nothing to inject')
      return undefined
    }
    if (built.droppedForBudget) {
      // A human with 300 memories who sees 6 needs to know the rest were
      // considered and cut, not that they were never found.
      ctx.log(
        `session context: injected ${built.included.length} memor(ies), ${built.bytes}B — ` +
          `${built.droppedForBudget} ranked but did not fit the budget`,
      )
    }
    // Record ONLY what was actually injected. Hits that ranked but did not fit
    // the budget were never in front of anyone, and recording them would inflate
    // usage for memories nobody saw — and warm them against decay for losing.
    if (built.included.length) {
      recordSurfacing(new MemoryStore(ctx.db), built.included, sessionId, Date.now())
    }

    // Injection is a selection, so the session also needs to know it can ASK.
    const hint = recallHint(built.included.length, new MemoryStore(ctx.db).countRecallable())
    const active = activeBlock(ctx, (payload ?? {}) as SessionPayload)
    const restored = restoreBlock(ctx, (payload ?? {}) as SessionPayload)
    return { additionalContext: [restored, built.text, active, hint].filter(Boolean).join('\n\n') }
  } catch (err) {
    ctx.log(`session context failed (session unaffected): ${err instanceof Error ? err.message : err}`)
    return undefined
  }
}

/**
 * SessionEnd hands the sweep to a DETACHED process and returns at once.
 *
 * Claude Code exits right after SessionEnd and the dispatcher dies with it:
 * on the laptop (14 Oct) every other event traced and SessionEnd never did, and
 * a memory saved in the session was still a full file afterwards. A detached
 * `cortex-memory sweep` outlives the CLI. Its result lands in sweeps.jsonl.
 * Tests run it inline: a test never leaves processes behind.
 */
export const onSessionEnd = (payload: unknown, ctx?: ModuleCtx) => {
  if (!ctx?.db) return undefined
  if (underTest()) return ingestGuarded(payload, ctx, END_BUDGET_MS, 'session-end')
  try {
    const repo = path.resolve(import.meta.dirname, '..', '..', '..')
    const out = fs.openSync(path.join(ctx.dataDir, 'sweep-detached.log'), 'a')
    spawn(path.join(repo, 'node_modules', '.bin', 'tsx'), [path.join(repo, 'bin', 'cortex-memory.ts'), 'sweep', '--trigger', 'session-end'], {
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    }).unref()
  } catch (err) {
    ctx.log(`could not start the session-end sweep (${err instanceof Error ? err.message : String(err)}); the next session start sweeps instead`)
  }
  return undefined
}

const ingestGuarded = (
  payload: unknown,
  ctx: ModuleCtx | undefined,
  budgetMs: number,
  trigger: 'session-start' | 'session-end' = 'session-start',
) => {
  if (!ctx?.db) return undefined
  const p = (payload ?? {}) as SessionPayload
  try {
    runIngest(ctx, budgetMs, p.session_id, trigger)
  } catch (err) {
    // Ingest failing must never take down a session. Reported, not thrown.
    ctx.log(`ingest driver failed: ${err instanceof Error ? err.message : err}`)
  }
  return undefined
}
