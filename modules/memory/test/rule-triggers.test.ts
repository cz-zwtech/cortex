/**
 * Scoped rules at the tool call (ruleTriggers.ts, on-pre-tool-rules.ts) and
 * the user's override (ruleOverrides.ts, cortex-rules allow).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { ModuleCtx } from '../../../core/ctx.js'
import onPreToolRules from '../server/on-pre-tool-rules.js'
import { addOverride } from '../server/ruleOverrides.js'
import { readFires } from '../server/ruleReview.js'
import type { Rule } from '../server/rules.js'
import { firesOn, inScope } from '../server/ruleTriggers.js'

const rule = (name: string, when: string, enforce: Rule['enforce'], over: Partial<Rule> = {}): Rule => ({
  id: `${name}-id`,
  name,
  category: 'general',
  why: `why for ${name}`,
  source: [`${name}-source`],
  scope: 'user',
  valid: 'always',
  when,
  do: `do for ${name}`,
  check: 'manual',
  enforce,
  ...over,
})

const call = (tool: string, over: Partial<Parameters<typeof firesOn>[1]> = {}) => ({ tool, paths: [], text: '', ...over })

test('triggers: tool globs, path globs and keywords', () => {
  const browse = rule('no-browsing', 'tool:WebFetch,mcp__browser__*', 'deny')
  assert.ok(firesOn(browse, call('WebFetch')))
  assert.ok(firesOn(browse, call('mcp__browser__open')))
  assert.ok(!firesOn(browse, call('Bash')))
  const acme = rule('acme-files', 'path:**/clients/acme/**', 'remind')
  assert.ok(firesOn(acme, call('Write', { paths: ['/home/x/clients/acme/deck.html'] })))
  assert.ok(!firesOn(acme, call('Write', { paths: ['/home/x/clients/other/deck.html'] })))
  assert.ok(firesOn(rule('envs', 'path:*.env', 'deny'), call('Edit', { paths: ['/srv/app/.env'] })))
  const pay = rule('pay', 'keywords:salary,invoice', 'remind')
  assert.ok(firesOn(pay, call('Write', { text: 'Attach the Invoice and the salary sheet' })))
  assert.ok(!firesOn(pay, call('Write', { text: 'Attach the Invoice for October' })), 'one of two listed words is chance')
  assert.ok(firesOn(rule('one', 'keywords:invoice', 'remind'), call('Write', { text: 'the Invoice' })), 'a single listed word suffices')
  assert.ok(!firesOn(pay, call('Write', { text: 'invoiced items, salaried' })), 'whole words')
  assert.ok(!firesOn(rule('always', 'always', 'remind'), call('WebFetch')), 'always is the outbound audit\'s, not this')
  assert.ok(inScope(rule('r', 'tool:x', 'remind', { scope: 'repo:sample-app' }), { repo: 'sample-app', text: '', paths: [] }))
  assert.ok(!inScope(rule('r', 'tool:x', 'remind', { scope: 'repo:sample-app' }), { cwd: '/srv/work/sample-app/x', text: '', paths: [] }), 'by the git root, not a path segment')
})

const rig = (rules: Rule[]) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'))
  const ctx = { dataDir, log: () => {}, capabilities: { get: () => ({ list: () => rules }) } } as unknown as ModuleCtx
  const run = (tool_name: string, tool_input: Record<string, unknown> = {}) =>
    onPreToolRules({ tool_name, tool_input, session_id: 's1', cwd: '/home/x' }, ctx) as Promise<{ decision?: string; reason?: string; additionalContext?: string } | undefined>
  return { dataDir, run, fires: () => readFires(path.join(dataDir, 'rule-fires.jsonl')) }
}

test('deny refuses the call, quoting the rule, its why and how the user lifts it; remind informs; audit only logs', async () => {
  const { run, fires } = rig([
    rule('no-web-fetch', 'tool:WebFetch', 'deny'),
    rule('deck-style', 'path:**/decks/**', 'remind'),
    rule('no-todo', 'path:**/decks/**', 'audit', { check: 'regex:\\bTODO\\b' }),
  ])
  const denied = (await run('WebFetch', { url: 'https://example.com/page' }))!
  assert.equal(denied.decision, 'deny')
  assert.match(denied.reason!, /no-web-fetch: do for no-web-fetch\. Why: why for no-web-fetch/)
  assert.match(denied.reason!, /cortex-rules allow no-web-fetch --once/)
  const reminded = (await run('Write', { file_path: '/home/x/decks/q4.md', content: 'Revenue TODO up' }))!
  assert.equal(reminded.decision, undefined)
  assert.match(reminded.additionalContext!, /do for deck-style\. Why: why for deck-style \(from \[\[deck-style-source\]\]\)/)
  assert.doesNotMatch(reminded.additionalContext!, /no-todo/, 'audit says nothing')
  assert.equal((await run('Bash', { command: 'ls' })), undefined, 'nothing scoped to it')
  const outcomes = fires().map((f) => `${f.rule}:${f.outcome}`)
  assert.deepEqual(outcomes, ['no-web-fetch:denied', 'deck-style:reminded', 'no-todo:audited-violation'])
})

test('an override from the user lets one call through, then the rule denies again; a timed one lasts', async () => {
  const { dataDir, run, fires } = rig([rule('no-web-fetch', 'tool:WebFetch', 'deny')])
  addOverride(dataDir, { rule: 'no-web-fetch', at: Date.now(), once: true })
  const first = (await run('WebFetch'))!
  assert.equal(first.decision, undefined)
  assert.match(first.additionalContext!, /overridden by the user for this call/)
  assert.equal((await run('WebFetch'))!.decision, 'deny', 'once is once')
  addOverride(dataDir, { rule: 'no-web-fetch', at: Date.now(), until: Date.now() + 60_000 })
  assert.equal((await run('WebFetch'))!.decision, undefined)
  assert.equal((await run('WebFetch'))!.decision, undefined, 'still inside the window')
  addOverride(dataDir, { rule: 'no-web-fetch', at: Date.now() - 120_000, until: Date.now() - 1 })
  assert.deepEqual(fires().map((f) => f.outcome), ['overridden', 'denied', 'overridden', 'overridden'])
})

test('cortex-rules allow refuses without a terminal: a session can never lift a rule itself', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..', '..')
  const r = spawnSync(path.join(repo, 'node_modules', '.bin', 'tsx'), [path.join(repo, 'bin', 'cortex-rules.ts'), 'allow', 'no-web-fetch', '--once'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  })
  assert.equal(r.status, 3, r.stderr)
  assert.match(r.stderr, /only in a terminal/)
})

test('cortex-rules allow refuses without a terminal even where no module is installed', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..', '..')
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-modules-'))
  const r = spawnSync(path.join(repo, 'node_modules', '.bin', 'tsx'), [path.join(repo, 'bin', 'cortex-rules.ts'), 'allow', 'no-web-fetch', '--once'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CKN_MODULES_DIR: empty },
  })
  assert.equal(r.status, 3, r.stderr)
  assert.match(r.stderr, /only in a terminal/)
})

// ── B: a lesson stated is a lesson kept ────────────────────────────────────

test('lesson gate: finds a stated lesson, not a quoted one', async () => {
  const { statedLesson } = await import('../server/on-stop-lesson.js')
  assert.ok(statedLesson('Fixed. Noted, I will not append to stub files again.'))
  assert.ok(statedLesson('Lesson learned: check the scope first.'))
  assert.ok(statedLesson('I should have run the suite before sending.'))
  assert.ok(statedLesson('From now on, I will rewrite the whole memory.'))
  assert.equal(statedLesson('The PM wrote "I will not append to stubs again" in the thread.'), null)
  assert.equal(statedLesson('```\n# I will never do this again\n```\nDone.'), null)
  assert.equal(statedLesson('All 481 tests pass; the deck is ready.'), null)
})

test('lesson gate: the turn goes back once unless a rule or feedback memory was written, or a commit is cited', async () => {
  const { default: onStopLesson } = await import('../server/on-stop-lesson.js')
  const { sweep } = await import('../server/sweep.js')
  const { Journal } = await import('../server/journal.js')
  const { fixture } = await import('./engagement-fixture.js')
  const { store, ctx, dataDir } = fixture()
  const reply = 'Merged. Noted, I will not append to stub files again.'
  const stop = (over: Record<string, unknown> = {}) =>
    onStopLesson({ session_id: 'L1', last_assistant_message: reply, ...over }, ctx) as { decision?: string; reason?: string } | undefined

  const bounced = stop()!
  assert.equal(bounced.decision, 'deny')
  assert.match(bounced.reason!, /kind: rule/)
  assert.match(bounced.reason!, /enforce: remind, audit, or deny/)
  assert.equal(stop({ stop_hook_active: true }), undefined, 'never twice')
  assert.equal(stop({ agent_id: 'sub' }), undefined, 'not subagents')
  assert.equal(stop({ last_assistant_message: `${reply} The fix is commit 0753cc9.` }), undefined, 'a mechanism fix, cited')

  const memoryDir = fs.mkdtempSync(path.join(dataDir, 'mem-'))
  fs.writeFileSync(
    path.join(memoryDir, 'memory-update-rewrite-not-append.md'),
    '---\nname: memory-update-rewrite-not-append\nkind: rule\nwhy: appended text below a stub became a stray memory\nwhen: path:**/memory/*.md\ndo: rewrite the whole memory; never append below a stub\nenforce: remind\n---\n\nRewrite, never append.\n',
  )
  sweep({ memoryDir, scope: 'user', machine: 'node-a', sessionId: 'L1' }, { store, journal: new Journal({ dir: path.join(dataDir, 'journal'), machine: 'node-a' }) })
  assert.equal(stop(), undefined, 'the rule was written this session')
  assert.equal(stop({ session_id: 'L2' })?.decision, 'deny', 'another session wrote nothing')
})

// ── C: rules that fired and were broken anyway ─────────────────────────────

test('review: repeat offences are listed with the exact change to make, never applied', async () => {
  const { review, corrections, promotion } = await import('../server/ruleReview.js')
  const { appendFire } = await import('../server/ruleReview.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'))
  const fires = path.join(dir, 'rule-fires.jsonl')
  const now = Date.now()
  const noFetch = rule('no-web-fetch', 'tool:WebFetch', 'remind', { do: 'never fetch web pages; use the local mirror', why: 'the build must run offline' })
  const todos = rule('no-todo', 'text_for:external', 'audit', { do: 'no TODO markers', check: 'regex:\\bTODO\\b' })
  const quiet = rule('quiet-rule', 'tool:Bash', 'remind', { do: 'prefer rg over grep' })
  for (const [r, o, s] of [
    ['no-web-fetch', 'reminded', 's1'],
    ['no-todo', 'reminded', 's2'],
    ['no-todo', 'audited-violation', 's2'],
    ['no-todo', 'audited-violation', 's3'],
    ['quiet-rule', 'reminded', 's1'],
  ] as const)
    appendFire(fires, { at: now - 1000, rule: r, session: s, event: 'PreToolUse', what: 'x', findings: o === 'audited-violation' ? 1 : 0, outcome: o })
  const said = [
    { text: 'You fetched a web page again. Use the local mirror, I told you.', at: now - 500 },
    { text: 'Thanks, that works.', at: now - 400 },
  ]
  assert.deepEqual([...corrections([noFetch, todos, quiet], said)], [['no-web-fetch', 1]])
  assert.deepEqual(promotion(noFetch, 0, 1), [
    'enforce: remind -> enforce: deny',
    'add an always-on companion (when: always, enforce: remind): it was broken away from tool:WebFetch',
  ])
  const lines = review([noFetch, todos, quiet], fires, { days: 7, now, sourceExists: () => true, said })
  const at = lines.findIndex((l) => l.startsWith('Repeat offences'))
  const section = lines.slice(at + 1, lines.indexOf('', at + 1))
  assert.equal(section.length, 2, section.join('\n'))
  assert.match(section[0]!, /no-todo: 2 violation\(s\), 1 after a reminder, 0 correction\(s\) by the user\. Change: enforce: audit -> enforce: deny/)
  assert.match(section[1]!, /no-web-fetch: 0 violation\(s\), 0 after a reminder, 1 correction\(s\) by the user\. Change: enforce: remind -> enforce: deny/)
})

test('scope: a repo rule only in that repo, a role rule only for that role, client:* never, keywords on what goes out', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'))
  const repo = path.join(root, 'sample-app')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'modules'))
  const personal = path.join(root, 'personal')
  fs.mkdirSync(personal)
  const rules = [
    rule('squash-merges', 'tool:Bash', 'remind', { scope: 'repo:sample-app' }),
    rule('pm-short-updates', 'tool:Bash', 'remind', { scope: 'role:pm' }),
    rule('vendor-terms', 'keywords:contract,renewal,vendor', 'remind', { scope: 'client:*' }),
    rule('acme-only', 'tool:Write', 'remind', { scope: 'client:acme' }),
    rule('no-prefix', 'keywords:module,tool,repo,name', 'remind'),
  ]
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'))
  const ctx = (roles?: string[]) =>
    ({
      dataDir,
      log: () => {},
      capabilities: { get: (k: string) => (k === 'memory.rules' ? { list: () => rules } : k === 'comms.sessionRoles' && roles ? async () => ({ bound: true, roles }) : undefined) },
    }) as unknown as ModuleCtx
  const fired = async (cwd: string, tool_name: string, tool_input: Record<string, unknown>, roles?: string[]) => {
    const r = (await onPreToolRules({ tool_name, tool_input, session_id: 's', cwd }, ctx(roles))) as { additionalContext?: string } | undefined
    return [...(r?.additionalContext ?? '').matchAll(/do for ([\w-]+)/g)].map((m) => m[1])
  }
  assert.deepEqual(await fired(personal, 'Bash', { command: 'scp contract-renewal.md host:/srv/docs/ --name x' }), [], 'nothing: an unrelated folder, a command line')
  assert.deepEqual(await fired(path.join(repo, 'modules'), 'Bash', { command: 'git status' }), ['squash-merges'], 'inside that repo')
  assert.deepEqual(await fired(personal, 'Bash', { command: 'ls' }, ['pm']), ['pm-short-updates'], 'a PM session')
  assert.deepEqual(await fired(personal, 'Bash', { command: 'ls' }, ['dev']), [], 'not a PM session')
  assert.deepEqual(await fired(personal, 'Write', { file_path: path.join(personal, 'clients', 'acme', 'renewal.md'), content: 'the contract renewal for the vendor' }), ['acme-only'], 'client:* never; client:acme by its path')
  assert.deepEqual(await fired(personal, 'Write', { file_path: path.join(personal, 'notes.md'), content: 'Every module repo needs a name check.' }), ['no-prefix'], 'two listed words in what is written')
})

test('review: a correction answers the assistant, names the rule by a phrase, comes after it, and counts once', async () => {
  const { corrections } = await import('../server/ruleReview.js')
  const now = Date.now()
  const todos = rule('no-todo', 'text_for:external', 'audit', { do: 'no TODO markers in outgoing text', why: 'TODO markers read as unfinished work', since: now - 10_000 })
  const stubs = rule('rewrite-not-append', 'path:**/memory/*.md', 'remind', { do: 'rewrite the whole memory file', why: 'appended text became a stray memory', since: now - 1_000 })
  const terms = rule('vendor-terms', 'keywords:retention,vendor', 'remind', { do: 'check vendor retention policy', since: now - 10_000 })
  const said = (text: string, over: Partial<{ at: number; after: string | null }> = {}) => ({ text, at: now - 500, after: 'assistant', ...over })
  const count = (s: ReturnType<typeof said>[]) => Object.fromEntries(corrections([todos, stubs, terms], s))

  assert.deepEqual(count([said('No TODO markers, I told you again.')]), { 'no-todo': 1 })
  assert.deepEqual(count([said('No TODO markers, I told you again.', { after: 'user' })]), {}, 'not answering the assistant')
  assert.deepEqual(count([said('Rewrite the whole memory file, do not append.', { at: now - 5_000 })]), {}, 'before the rule existed')
  assert.deepEqual(count([said('Do not write text in client memory files again.')]), {}, 'common words, no phrase of the rule')
  assert.deepEqual(count([said('Again: check the retention terms for that vendor.')]), { 'vendor-terms': 1 }, 'a keyword')
  assert.deepEqual(count([said('Again, TODO markers, and you appended text to the memory file instead of a rewrite of the whole memory file.')]), { 'rewrite-not-append': 1 }, 'once, to the rule it names most')
})

test('path: is the file a call touches, never the cwd; cwd: opts in to the folder', async () => {
  const docs = rule('docs-review', 'path:**/docs/**', 'remind')
  assert.ok(!firesOn(docs, call('Bash', { cwd: '/home/x/docs/sample co/q4' })), 'standing in docs is not writing there')
  assert.ok(firesOn(docs, call('Write', { paths: ['/home/x/docs/sample co/q4/plan.md'] })))
  assert.ok(firesOn(rule('in-docs', 'cwd:**/docs/**', 'remind'), call('Bash', { cwd: '/home/x/docs/sample co/q4' })))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'))
  const ctx = { dataDir, log: () => {}, capabilities: { get: () => ({ list: () => [docs] }) } } as unknown as ModuleCtx
  assert.equal(await onPreToolRules({ tool_name: 'Monitor', tool_input: { command: 'tail -f x' }, session_id: 's', cwd: '/home/x/docs/sample co' }, ctx), undefined)
  assert.equal(await onPreToolRules({ tool_name: 'Grep', tool_input: { pattern: 'x', path: '/home/x/docs' }, session_id: 's', cwd: '/home/x' }, ctx), undefined, 'a search folder is not a file')
})
