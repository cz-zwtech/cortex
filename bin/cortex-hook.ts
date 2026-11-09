#!/usr/bin/env tsx
/**
 * The dispatcher — core's single hook entry point.
 *
 * The harness invokes this once per lifecycle event. It loads the installed
 * modules, runs every subscriber for that event IN PROCESS, in declared order,
 * inside a budget, and emits one consolidated result.
 *
 * This is the coordination model's whole substance. Before this file, "core
 * coordinates rather than fanning out" was a design claim with nothing behind
 * it.
 *
 * Failure policy: this process must NEVER take down the user's session. Any
 * error anywhere is caught, reported on stderr, and the process exits 0 with a
 * valid (possibly empty) result. A memory tool that can break a coding session
 * is worse than no memory tool.
 */

import fs from 'node:fs'
import path from 'node:path'

import { EventBus } from '../core/events.js'
import offers from '../core/offers.js'
import { RENAMED, SessionNames, type Renamed, type RenamedResult } from '../core/sessionNames.js'
import { Storage } from '../core/storage.js'
import { Lifecycle } from '../core/lifecycle.js'
import { LIFECYCLE_EVENTS, type LifecycleEvent } from '../core/manifest.js'
import { DEFAULT_HOOK_TIMEOUT_MS, resyncCommands } from '../core/harness.js'
import { aggregateContext, aggregateTitle, buildHookResponse, canRefuse, canSetTitle, type Contribution } from '../core/aggregate.js'
import { aggregateDecision } from '../core/aggregate.js'
import { claudeConfigDir, dataRoot, dbPath, modulesDir, stateDir } from '../core/paths.js'
import { CANARY_TOOL_MARKER, livenessEnabled, mintNonce, nonceLine } from '../core/liveness.js'
import { trace } from '../core/trace.js'
import { updateInProgress } from '../core/updateLock.js'

/**
 * Leave headroom under the harness timeout so we can always report. Being
 * killed by the harness produces no output at all, which is the one outcome
 * that tells the user nothing.
 */
const BUDGET_HEADROOM_MS = 1_500
const TOTAL_BUDGET_MS = DEFAULT_HOOK_TIMEOUT_MS - BUDGET_HEADROOM_MS
const PER_SUBSCRIBER_MS = Math.floor(TOTAL_BUDGET_MS / 2)

const main = async () => {
  const event = process.argv[2]
  // cortex-update is swapping code or dependencies: skip this hook rather than
  // run a half-updated tree. A skipped hook is a missed injection, never an error.
  if (updateInProgress(stateDir())) return
  if (!event || !(LIFECYCLE_EVENTS as readonly string[]).includes(event)) {
    console.error(`[cortex-hook] unknown event: ${event ?? '(none)'}`)
    return
  }

  // The harness passes its payload on stdin. Absence is normal, not an error.
  let payload: unknown
  try {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf-8').trim()
    if (raw) payload = JSON.parse(raw)
  } catch {
    /* unparseable stdin is not worth failing an event over */
  }

  // STATE, not install. CKN_HOME is the checkout: deriving writable paths from
  // it puts the database inside a git repo on every machine, and on a WSL machine
  // puts the journal on drvfs — which cannot keep the durability promise the
  // journal makes, so it would refuse to open at all. See core/paths.ts.
  const events = new EventBus()
  const storage = new Storage(dbPath())
  const lifecycle = new Lifecycle({
    modulesDir: modulesDir(),
    dataRoot: dataRoot(),
    dbPath: storage.path,
    events,
    storage,
    log: (msg) => console.error(msg),
  })

  // Minted per INVOCATION. It is echoed to the harness (which records what it
  // injected, in its own transcript) and recorded in the trace, so the two can
  // be JOINED. A stale artifact from a previous run cannot carry this run's
  // nonce, which is what stops evidence that would exist either way.
  const nonce = mintNonce()

  // Core's own SessionStart offers (the status line, an update), in the dispatch like a module's.
  // A bare install (no module) says nothing at all.
  events.subscribe('SessionStart', 'core', (p) => (lifecycle.statuses.length ? offers(p, { dataDir: path.join(dataRoot(), 'setup') }) : undefined), 90)

  const started = Date.now()
  await lifecycle.run()

  // SESSION NAMING (core, 19 Oct). Before the event itself, so a module resolving its member from the
  // title sees the rename already followed: the harness's own /rename is noticed here (the reported title
  // changed with nothing pending) and published as session.renamed, as /cortex-rename does.
  const sessionNames = SessionNames.at(stateDir())
  const sid = sessionIdOf(payload)
  const subagent = !!(payload as Record<string, unknown>).agent_id
  const coreLines: string[] = []
  if (sid && !subagent && canSetTitle(event)) {
    const changed = sessionNames.observe(sid, (payload as Record<string, unknown>).session_title as string | undefined)
    if (changed) {
      const r = await events.publish(RENAMED, { sessionId: sid, ...changed, args: [], force: false, source: 'harness' } satisfies Renamed)
      for (const x of r.results) coreLines.push(...((x.value as RenamedResult)?.lines ?? []))
      for (const f of r.failures) console.error(`[cortex-hook] ${f.module} could not follow the rename: ${f.error.message}`)
    }
  }
  const pendingTitle = sid && !subagent && canSetTitle(event) ? sessionNames.takePending(sid) : undefined

  const result = await events.publish(event as LifecycleEvent, payload, {
    perSubscriberMs: PER_SUBSCRIBER_MS,
    totalMs: TOTAL_BUDGET_MS - (Date.now() - started),
  })

  // DURABLE EVIDENCE THAT THIS EVENT REACHED US, written before anything can
  // go wrong downstream and written even when NO module is installed and no
  // subscriber ran. That case — the naked scaffold core claims to support — is
  // exactly the one where a hook that fired and a hook that never ran used to
  // produce byte-identical evidence.
  trace({
    event,
    at: new Date().toISOString(),
    subscribers: result.delivered,
    durationMs: Date.now() - started,
    modules: lifecycle.started.length,
    nonce,
    // Harness-supplied and un-inventable: it names a transcript file Cortex
    // never writes, so it corroborates the entry from outside this process.
    ...(sessionIdOf(payload) ? { session: sessionIdOf(payload) } : {}),
    // Also harness-minted. `tool_name` only exists on a real PreToolUse /
    // PostToolUse payload, so its presence is provenance the dispatcher could
    // not fabricate for itself.
    ...(toolNameOf(payload) ? { tool: toolNameOf(payload) } : {}),
    ...(result.failures.length ? { failures: result.failures.map((f) => f.module) } : {}),
  })

  await lifecycle.stopAll()
  storage.close()

  for (const f of result.failures) {
    console.error(
      `[cortex-hook] ${f.module}: ${f.timedOut ? 'exceeded budget' : 'failed'} — ${f.error.message}`,
    )
  }

  // One consolidated response for the harness, from N subscribers.
  //
  // This is the RETURN direction, and it is the half that was missing when the
  // dispatcher was first built: context contributions are additive, decisions
  // conflict, and merging them with one rule is wrong in both directions. See
  // core/aggregate.ts.
  //
  // Subscriber order is preserved here so a module's declared priority governs
  // injection order — core cannot judge cross-module relevance and does not try.
  //
  // The bus pairs each result with its module rather than returning a bare
  // array, so a subscriber that FAILED cannot shift the attribution of every
  // result after it.
  const contributions: Contribution[] = result.results.map((r) => ({
    module: r.module,
    response: r.value as Contribution['response'],
  }))
  // A rename is core's, so its title comes first and no module can overrule it.
  if (pendingTitle) contributions.unshift({ module: 'core:session', response: { sessionTitle: pendingTitle } })
  if (coreLines.length) contributions.unshift({ module: 'core:session', response: { additionalContext: coreLines.join('\n') } })
  // ── LIVENESS ECHO — OPT-IN, AND NO LONGER A PRIVILEGED PATH ──────────────
  //
  // An earlier revision appended this to hookSpecificOutput AFTER aggregation,
  // on every SessionStart and UserPromptSubmit. That gave core a private,
  // unbudgeted, always-on write channel into the model's context: exempt from
  // the byte budget, exempt from truncation reporting, and impossible for a
  // human to turn off. The content was harmless; the PATH was the problem, and
  // a random nonce arriving every session was proof it was live and unguarded.
  //
  // It is now (a) off unless CORTEX_LIVENESS=on and (b) an ordinary
  // contribution, so it competes for the same budget as every module and gets
  // reported when it does not fit. There is exactly ONE way text reaches the
  // model, and nothing is exempt from it.
  //
  // Keeping it on hookSpecificOutput rather than the top level is still right:
  // SessionStart accepted a top-level additionalContext and UserPromptSubmit
  // silently ignored it — a corroboration route that failed without failing.
  if (livenessEnabled() && (event === 'SessionStart' || event === 'UserPromptSubmit')) {
    contributions.push({
      module: 'core:liveness',
      response: { additionalContext: nonceLine(event, nonce) },
    })
  }


  // Core reports the pressure it cannot fix. A module whose contribution is
  // internally redundant crowds others out, and without these numbers neither
  // the author nor the human ever learns it happened.
  for (const t of aggregateContext(contributions).truncated) {
    console.error(
      `[cortex-hook] ${t.module}: ${t.bytes}B contribution dropped, only ${t.remainingBytes}B of injection budget left`,
    )
  }

  // A title request the harness cannot honour, or one that lost to another
  // module, is reported for the same reason truncation is: never silent.
  const title = aggregateTitle(contributions)
  // Whatever title goes to the harness is the one core expects back, so it is not mistaken for a /rename.
  if (sid && title.sessionTitle && canSetTitle(event)) sessionNames.record(sid, title.sessionTitle)
  if (title.sessionTitle && !canSetTitle(event)) {
    console.error(`[cortex-hook] ${title.setBy} asked to set the session title on ${event}, which cannot carry one`)
  }
  for (const m of title.overruled) {
    console.error(`[cortex-hook] ${m}: session title request overruled by ${title.setBy}`)
  }

  // ── A REFUSAL THAT CANNOT BE EXPRESSED MUST BE LOUD, NOT SILENT ──────────
  //
  // Measured against a real harness: a malformed refusal is DISCARDED and the
  // operation proceeds. So an event that cannot carry a deny must say so where
  // a human will see it, rather than emitting something that gets dropped and
  // reading as permission.
  const decision = aggregateDecision(contributions)
  if (decision.decision === 'deny' && !canRefuse(event)) {
    console.error(
      `[cortex-hook] ${decision.deniedBy} DENIED ${event}, but ${event} cannot carry a refusal — ` +
        `the operation WILL PROCEED. Reason: ${decision.reason ?? '(none given)'}`,
    )
  }

  const response = buildHookResponse(contributions, event) ?? {}

  // ── CANARY DENY ──────────────────────────────────────────────────────────
  //
  // The strongest available proof for PreToolUse: a deny BLOCKS the tool call
  // and the harness records the denial and its reason in the transcript. That
  // is behavioural — the evidence cannot exist unless the hook actually ran and
  // its verdict was actually honoured.
  //
  // Scoped to one canary string no real command would contain, rather than
  // hidden behind a flag. A flag would make the deny path test-only, and a
  // mechanism that only exists under test is the defect this whole trace was
  // built to fix. Denying a command that literally names itself a Cortex UAT
  // canary harms nobody.
  if (event === 'PreToolUse' && JSON.stringify(payload ?? {}).includes(CANARY_TOOL_MARKER)) {
    const specific = (response.hookSpecificOutput ?? { hookEventName: 'PreToolUse' }) as Record<
      string,
      unknown
    >
    specific.permissionDecision = 'deny'
    specific.permissionDecisionReason = `Cortex UAT canary — PreToolUse ran and its verdict was honoured (nonce ${nonce})`
    response.hookSpecificOutput = specific
  }

  if (Object.keys(response).length) process.stdout.write(JSON.stringify(response))

  // COMMANDS FOLLOW THE CHECKOUT. A deploy updates the shared checkout as one user, but each user's
  // commands dir is their own (19 Oct: a user's cortex-rename.md stayed comms' after a deploy run as
  // svc). So each session start re-syncs this user's commands; unchanged files are not rewritten.
  // Only for the checkout this user's hooks run: another checkout (a dev clone, a test) must never
  // re-point the user's commands at itself.
  if (event === 'SessionStart') {
    try {
      const repoRoot = path.resolve(import.meta.dirname, '..')
      const claudeDir = claudeConfigDir()
      const settings = fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8')
      // An environment that does not match this checkout and this config is a dev run or its child: a re-sync
      // from it wrote the real commands and CLAUDE.md from a temporary state on 27 Oct. Mismatched means
      // modules from another checkout, or a redirected Cortex state against the real Claude config.
      const real = (p: string) => {
        try {
          return fs.realpathSync(p)
        } catch {
          return path.resolve(p)
        }
      }
      const foreignModules = !!process.env.CKN_MODULES_DIR && !real(process.env.CKN_MODULES_DIR).startsWith(real(repoRoot) + path.sep)
      const strayState = !!(process.env.CKN_STATE_DIR || process.env.CKN_MEMORY_DIRS) && !process.env.CLAUDE_CONFIG_DIR
      const overridden = foreignModules || strayState
      if (!overridden && settings.includes(path.join(repoRoot, 'bin', 'cortex-hook.ts'))) {
        await resyncCommands({ claudeDir, repoRoot, modulesDir: modulesDir() }, true)
      }
    } catch (err) {
      console.error(`[cortex-hook] command re-sync skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

main()
  .catch((err) => {
    console.error('[cortex-hook] dispatcher error:', err)
  })
  .finally(() => {
    // Always 0. A hook that fails must not fail the session.
    process.exit(0)
  })

/** The harness's own session id, when the payload carries one. */
function sessionIdOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const v = (payload as Record<string, unknown>).session_id
  return typeof v === 'string' && v ? v : undefined
}

/** The tool the harness is about to run, on PreToolUse/PostToolUse payloads. */
function toolNameOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const v = (payload as Record<string, unknown>).tool_name
  return typeof v === 'string' && v ? v : undefined
}
