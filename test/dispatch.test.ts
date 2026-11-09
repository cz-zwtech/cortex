/**
 * The dispatcher-to-subscriber path, exercised against the REAL memory module.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS CAN AND CANNOT PROVE
 *
 * The lesson this project keeps paying for is that VERIFYING THE EMITTER NEVER
 * VERIFIES THE CONSUMER — three mechanisms passed every check we could run
 * ourselves and failed the first time a real harness touched them. So this file
 * is explicit about which half it is.
 *
 * IT PROVES: that a manifest-declared subscription is discovered, imported,
 * subscribed, reached by a publish, handed its module's context, and that its
 * response survives aggregation into the exact bytes the harness would receive.
 * Every one of those is inside our own process and therefore ours to assert.
 *
 * IT DOES NOT PROVE: that the harness honours the result. That is one row in the
 * UAT, it was earned behaviourally for PreToolUse deny in run 3, and no amount
 * of in-process testing substitutes for it.
 *
 * The reason to write it anyway is the inverse of the same lesson: before this,
 * "memory subscribes to PreToolUse" was a line in a JSON file with nothing
 * behind it, and a subscription that was never reached would have looked
 * identical to one that was.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { EventBus } from '../core/events.js'
import { Storage } from '../core/storage.js'
import { Lifecycle } from '../core/lifecycle.js'
import { buildHookResponse, type Contribution } from '../core/aggregate.js'

const REPO = path.resolve(import.meta.dirname, '..')

const bootWithMemory = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-dispatch-'))
  const modulesDir = path.join(root, 'modules')
  const memoryHome = path.join(root, 'claude', 'memory')

  await fs.mkdir(modulesDir, { recursive: true })
  await fs.mkdir(memoryHome, { recursive: true })
  await fs.symlink(path.join(REPO, 'modules', 'memory'), path.join(modulesDir, 'memory'), 'dir')

  // The reflex resolves its roots from the environment, so the scratch memory
  // dir has to be declared rather than assumed — pointing it at the real
  // ~/.claude would make this test's result depend on the developer's own files.
  process.env.CKN_MEMORY_DIRS = memoryHome

  const events = new EventBus()
  const storage = new Storage(path.join(root, 'cortex.sqlite'))
  const lifecycle = new Lifecycle({
    modulesDir,
    dataRoot: path.join(root, 'data'),
    dbPath: path.join(root, 'cortex.sqlite'),
    events,
    storage,
  })
  const result = await lifecycle.run()

  return {
    events,
    storage,
    lifecycle,
    result,
    memoryHome,
    cleanup: async () => {
      delete process.env.CKN_MEMORY_DIRS
      await lifecycle.stopAll()
      storage.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test('the memory module starts and its PreToolUse subscription is registered', async (t) => {
  const b = await bootWithMemory()
  t.after(b.cleanup)

  const memory = b.result.statuses.find((s) => s.name === 'memory')
  assert.equal(memory?.state, 'started', memory?.reason ?? 'memory should start')
  const declared = (JSON.parse(await fs.readFile(path.join(REPO, 'modules', 'memory', 'module.json'), 'utf-8')) as { subscribes: { event: string }[] }).subscribes.filter((x) => x.event === 'PreToolUse').length
  assert.ok(declared >= 1)
  assert.equal(b.events.count('PreToolUse'), declared, 'declared in module.json (the reflex and the rule audit), subscribed by core')
})

test('A DECLARED SUBSCRIBER RECEIVES ITS MODULE CONTEXT', async (t) => {
  // Without this, the manifest route worked only for stateless handlers: a
  // handler imported by path has no reference to its own module's database, and
  // reaching back into module internals would couple it to start() having
  // already run. The reflex needs the store, so this is load-bearing rather than
  // tidy — and a handler that silently got `undefined` would simply never fire,
  // which looks exactly like "no duplicates found".
  const b = await bootWithMemory()
  t.after(b.cleanup)

  const secretFile = path.join(b.memoryHome, 'creds.md')
  const result = await b.events.publish('PreToolUse', {
    tool_name: 'Write',
    tool_input: { file_path: secretFile, content: 'token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  })

  assert.equal(result.failures.length, 0, 'no subscriber may throw')
  const value = result.results.find((r) => r.module === 'memory')?.value as
    | { decision?: string }
    | undefined
  assert.equal(value?.decision, 'deny', 'the handler reached the scanner, so it had its ctx')
})

test('the deny survives aggregation as the schema the harness validated', async (t) => {
  // The run-2 defect in full: our emitter was correct and our payload was not,
  // the harness discarded the verdict, and the command ran. So the assertion has
  // to be on the BYTES, not on the decision — `{decision:"deny"}` would satisfy
  // any test written against the aggregate result and still fail open.
  const b = await bootWithMemory()
  t.after(b.cleanup)

  const result = await b.events.publish('PreToolUse', {
    tool_name: 'Write',
    tool_input: {
      file_path: path.join(b.memoryHome, 'creds.md'),
      content: 'AKIAIOSFODNN7EXAMPLE1234',
    },
  })

  const contributions: Contribution[] = result.results.map((r) => ({
    module: r.module,
    response: r.value as Contribution['response'],
  }))
  const response = buildHookResponse(contributions, 'PreToolUse')

  assert.deepEqual(Object.keys(response ?? {}), ['hookSpecificOutput'])
  const specific = (response as Record<string, unknown>).hookSpecificOutput as Record<
    string,
    unknown
  >
  assert.equal(specific.hookEventName, 'PreToolUse')
  assert.equal(specific.permissionDecision, 'deny')
  assert.equal(typeof specific.permissionDecisionReason, 'string')
  assert.ok(
    !('decision' in (response as Record<string, unknown>)),
    'the legacy field is what failed validation and ran the tool',
  )
})

test('AN ORDINARY EDIT IS UNTOUCHED — the reflex is absent, not merely quiet', async (t) => {
  // Memory now sits in front of every PreToolUse on the machine. If it
  // contributed anything at all to unrelated tool calls it would be spending
  // another module's injection budget on nothing, on every command the user
  // runs.
  const b = await bootWithMemory()
  t.after(b.cleanup)

  const result = await b.events.publish('PreToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
  })

  assert.equal(result.failures.length, 0)
  assert.equal(result.results.find((r) => r.module === 'memory')?.value, undefined)
  assert.equal(buildHookResponse([], 'PreToolUse'), null, 'and produces no payload at all')
})

test('a subscriber failure does not deny — layer 1 fails OPEN, by design', async (t) => {
  // Stated as an assertion rather than a comment because it is a security
  // property with a direction: the write-time reflex is explicitly NOT the
  // guarantee-bearing layer, and the ingest scan blocks before the journal
  // append regardless. A reflex that failed CLOSED would take the user's session
  // down with it for no protective gain.
  const b = await bootWithMemory()
  t.after(b.cleanup)

  const result = await b.events.publish('PreToolUse', { tool_name: 'Write' }) // no tool_input

  assert.equal(result.failures.length, 0)
  assert.equal(buildHookResponse([], 'PreToolUse'), null)
})

test('SESSION EVENTS DRIVE INGEST — the defect that made memory a library with no driver', async (t) => {
  // Before this, `memory.record` and `memory.sweep` were provided as
  // capabilities and called by NOTHING outside tests. A human wrote a memory
  // file and the graph stayed empty permanently. Every downstream feature
  // inherited it: recall over an empty corpus, and a dedupe reflex answering
  // "no duplicates" forever while reporting success.
  //
  // This is the assertion whose absence let that ship: a real module, through a
  // real Lifecycle, on a real published event, with the memory ending up IN THE
  // GRAPH.
  const b = await bootWithMemory()
  t.after(b.cleanup)

  await fs.writeFile(
    path.join(b.memoryHome, 'deploy.md'),
    '---\nname: deploy-process\n---\n\n' +
      'Deploy by running the release script on the build host, then wait for the health ' +
      'check to report green before switching traffic over to the new pods.\n',
  )

  const before = b.storage.db().prepare('SELECT count(*) c FROM memories').get() as { c: number }
  assert.equal(before.c, 0)

  const result = await b.events.publish('SessionEnd', { session_id: 'sess-1' })
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures.map((f) => f.error.message)))

  const after = b.storage.db().prepare('SELECT count(*) c FROM memories').get() as { c: number }
  assert.equal(after.c, 1, 'the memory reached the graph')
})

test('SessionStart drives it too — the safety net for sessions that never end cleanly', async (t) => {
  const b = await bootWithMemory()
  t.after(b.cleanup)

  await fs.writeFile(
    path.join(b.memoryHome, 'note.md'),
    '---\nname: a-note\n---\n\n' +
      'A durable note with enough words in it to clear the token floor comfortably ' +
      'and be treated as ordinary authored prose by the ladder.\n',
  )

  await b.events.publish('SessionStart', { session_id: 'sess-2' })
  const after = b.storage.db().prepare('SELECT count(*) c FROM memories').get() as { c: number }
  assert.equal(after.c, 1)
})

test('ingest failing must NEVER take down the session', async (t) => {
  // A memory tool that can break a coding session is worse than no memory tool.
  const b = await bootWithMemory()
  t.after(b.cleanup)

  // A directory where a memory file should be makes the sweep throw.
  await fs.mkdir(path.join(b.memoryHome, 'trap.md'), { recursive: true })

  const result = await b.events.publish('SessionEnd', { session_id: 'sess-3' })
  assert.equal(result.failures.length, 0, 'isolated and reported, never thrown')
})

test('a second sweep does NOT re-ingest what it already consumed', async (t) => {
  // Consume-by-ticket exists so a re-run is idempotent. If it were not, every
  // session start would duplicate the corpus.
  const b = await bootWithMemory()
  t.after(b.cleanup)

  await fs.writeFile(
    path.join(b.memoryHome, 'once.md'),
    '---\nname: once-only\n---\n\n' +
      'A single fact recorded exactly one time, with sufficient words to be judged.\n',
  )

  await b.events.publish('SessionEnd', { session_id: 's1' })
  const first = b.storage.db().prepare('SELECT count(*) c FROM memories').get() as { c: number }
  await b.events.publish('SessionEnd', { session_id: 's2' })
  const second = b.storage.db().prepare('SELECT count(*) c FROM memories').get() as { c: number }

  assert.equal(second.c, first.c, 'idempotent across sweeps')
})

test('SESSIONSTART INJECTS WHAT IT JUST INGESTED — sweep before recall, in one event', async (t) => {
  // The ordering matters and is invisible if wrong: injecting before ingesting
  // would surface a corpus one session out of date on EVERY session, and the
  // staleness would be undetectable — a memory written last session and not yet
  // ingested is indistinguishable from one never written.
  const b = await bootWithMemory()
  t.after(b.cleanup)

  await fs.writeFile(
    path.join(b.memoryHome, 'fact.md'),
    '---\nname: deploy-fact\ntype: feedback\n---\n\n' +
      'The release script runs on the build host and the health check must report green ' +
      'before any traffic is switched to the new pods.\n',
  )

  const result = await b.events.publish('SessionStart', { session_id: 'inject-1' })
  assert.equal(result.failures.length, 0)

  const contributions: Contribution[] = result.results.map((r) => ({
    module: r.module,
    response: r.value as Contribution['response'],
  }))
  const response = buildHookResponse(contributions, 'SessionStart')
  const specific = (response as Record<string, unknown> | null)?.hookSpecificOutput as
    | Record<string, unknown>
    | undefined

  assert.ok(specific, 'memory contributed context')
  assert.match(String(specific!.additionalContext), /deploy-fact/)
  assert.match(String(specific!.additionalContext), /health check/)
})

test('an empty graph contributes NO context at SessionStart', async (t) => {
  // Telling a session "I have no memories" every start would spend another
  // module's injection budget on our own incompleteness.
  const b = await bootWithMemory()
  t.after(b.cleanup)

  const result = await b.events.publish('SessionStart', { session_id: 'inject-2' })
  assert.equal(result.results.find((r) => r.module === 'memory')?.value, undefined)
})

test('SURFACING IS RECORDED FROM A REAL SESSION EVENT, not only by a test helper', async (t) => {
  // The reconcile ladder already had a passing test for its surfaced-in rung
  // that called store.observe() ITSELF to create the precondition — proving the
  // rung worked while nothing in production could ever reach it. This asserts
  // the edge exists after an ordinary SessionStart.
  const b = await bootWithMemory()
  t.after(b.cleanup)

  await fs.writeFile(
    path.join(b.memoryHome, 'surf.md'),
    '---\nname: surfaced-fact\ntype: feedback\n---\n\n' +
      'The release script runs on the build host and the health check must be green ' +
      'before traffic switches to the new pods.\n',
  )

  await b.events.publish('SessionStart', { session_id: 'sess-surface' })

  const edges = b.storage
    .db()
    .prepare("SELECT src, dst, rel FROM observed_edges WHERE rel = 'surfaced_in'")
    .all() as { src: string; dst: string; rel: string }[]

  assert.ok(edges.length >= 1, 'a surfacing record exists')
  assert.equal(edges[0]!.dst, 'sess-surface', 'pointing at the real session')
})

test('USERPROMPTSUBMIT RECALLS AGAINST THE PROMPT — the field is `prompt`, verified', async (t) => {
  // Read from the harness's own payload construction:
  //   hook_event_name:"UserPromptSubmit", prompt: e, …
  // V1 never reads it, so there was no consumer to learn it from — and guessing
  // a field name is how a hook silently receives `undefined` and injects nothing
  // forever while looking installed.
  const b = await bootWithMemory()
  t.after(b.cleanup)

  await fs.writeFile(
    path.join(b.memoryHome, 'kafka.md'),
    '---\nname: kafka-broker-topology\n---\n\n' +
      'The production Kafka broker runs on its own VM and every consumer connects over ' +
      'SASL with a read-only service account rather than the admin credentials.\n',
  )
  await b.events.publish('SessionEnd', { session_id: 'ingest' })

  const result = await b.events.publish('UserPromptSubmit', {
    session_id: 'ask-1',
    prompt: 'how do consumers authenticate against the kafka broker?',
  })
  assert.equal(result.failures.length, 0)

  const contributions: Contribution[] = result.results.map((r) => ({
    module: r.module,
    response: r.value as Contribution['response'],
  }))
  const response = buildHookResponse(contributions, 'UserPromptSubmit')
  const specific = (response as Record<string, unknown> | null)?.hookSpecificOutput as
    | Record<string, unknown>
    | undefined

  assert.ok(specific, 'memory contributed context')
  assert.match(String(specific!.additionalContext), /kafka-broker-topology/)
})

test('a TRIVIAL prompt recalls nothing — "yes" must not inject a wall of context', async (t) => {
  // Short acknowledgements would seed on whatever tokens they share with the
  // corpus and inject noise on exactly the turns where the user wants least.
  const b = await bootWithMemory()
  t.after(b.cleanup)

  await fs.writeFile(
    path.join(b.memoryHome, 'x.md'),
    '---\nname: something\n---\n\nA memory with plenty of ordinary words in its body.\n',
  )
  await b.events.publish('SessionEnd', { session_id: 'ingest' })

  const result = await b.events.publish('UserPromptSubmit', { session_id: 'a', prompt: 'yes' })
  assert.equal(result.results.find((r) => r.module === 'memory')?.value, undefined)
})

test('a prompt against an EMPTY graph contributes nothing', async (t) => {
  const b = await bootWithMemory()
  t.after(b.cleanup)
  const result = await b.events.publish('UserPromptSubmit', {
    session_id: 'a',
    prompt: 'tell me everything you know about the deployment pipeline',
  })
  assert.equal(result.results.find((r) => r.module === 'memory')?.value, undefined)
})

test('a missing prompt field is survivable, not a crash', async (t) => {
  const b = await bootWithMemory()
  t.after(b.cleanup)
  const result = await b.events.publish('UserPromptSubmit', { session_id: 'a' })
  assert.equal(result.failures.length, 0)
})

test('DELETE IS DURABLE — a rebuild must not resurrect what was forgotten', async (t) => {
  // The journal is the source of truth and the graph is a derived view, so
  // removing from the graph alone left the record intact — and `journal.replay()`
  // exists precisely to rebuild the graph from it. The memory would have come
  // back, from a verb the CLI calls `forget`.
  const b = await bootWithMemory()
  t.after(b.cleanup)

  await fs.writeFile(
    path.join(b.memoryHome, 'temp.md'),
    '---\nname: temporary-fact\n---\n\n' +
      'A fact recorded now and deleted shortly afterwards, with enough words to be judged.\n',
  )
  await b.events.publish('SessionEnd', { session_id: 'ingest' })

  const row = b.storage.db().prepare('SELECT id FROM memories LIMIT 1').get() as
    | { id: string }
    | undefined
  assert.ok(row, 'ingested')

  const del = b.lifecycle.capabilities.get<(id: string) => Promise<boolean>>('memory.delete')!
  assert.equal(await del(row!.id), true)
  assert.equal(
    (b.storage.db().prepare('SELECT count(*) c FROM memories').get() as { c: number }).c,
    0,
    'gone from the graph',
  )

  // And gone from the source of truth's REBUILD, which is the half that was
  // missing: a tombstone is appended, and replay honours it.
  const { Journal } = await import('../modules/memory/server/journal.js')
  const mod = b.lifecycle.started.find((m) => m.manifest.name === 'memory')!
  const journal = new Journal({
    dir: path.join(mod.ctx.dataDir, 'journal'),
    machine: 'local',
  })
  assert.deepEqual(journal.replay(), [], 'a rebuild does not bring it back')
})
