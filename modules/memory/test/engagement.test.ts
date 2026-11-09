/**
 * Memory engagement at the moments it matters: a prompt, a write for someone
 * else, a question about to go to the user. Two invented cases:
 *
 *   - a roster held in a table, in a memory longer than the prompt budget, and
 *     a prompt that names the role by department ("marketing", "c-suite"), not
 *     by title or name;
 *   - a constraint ("under embargo: don't share it with Sam") held in a
 *     meeting-note memory, not in the memory about the thing it constrains.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { RECALL_LOG } from '../server/recallLog.js'
import { fixture, logRows, prompt } from './engagement-fixture.js'

// ── F0: what recall decided is on record, without the words ─────────────────

test('F0: every prompt-time recall leaves a row: ids, scores and drops, never the prompt', () => {
  const { ctx, dataDir } = fixture()
  prompt(ctx, 'Who is the CMO on the Acme leadership team?')
  const rows = logRows(dataDir)
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.event, 'prompt')
  assert.equal(row.session, 's1')
  assert.ok(row.hits.some((h: { id: string }) => h.id === 'acme-leadership-announced-id'), 'the roster ranked')
  const raw = fs.readFileSync(path.join(dataDir, RECALL_LOG), 'utf-8')
  for (const word of ['Who is', 'leadership team?', 'Dana', 'Quill']) assert.ok(!raw.includes(word), `no text: ${word}`)
})

// ── F1: a long memory is shortened, never skipped ──────────────────────────

test('F1: a memory longer than the budget is shown as an excerpt: the matching row, its header, and where the rest is', () => {
  const { ctx } = fixture()
  const out = prompt(ctx, 'Who is the CMO on the Acme leadership team?')
  assert.match(out, /acme-leadership-announced/)
  assert.match(out, /\| CMO \| Dana Quill \|/)
  assert.match(out, /\| Role \| Name \|/, 'the header that says what the columns are')
  assert.match(out, /cortex-memory show acme-leadership-announced/)
  assert.ok(Buffer.byteLength(out) <= 2_400 + 200, 'inside the budget')
})

test('F1: every ranked hit gets a place when all of them are long', async () => {
  const { renderHits } = await import('../server/inject.js')
  const long = (n: number) => ({ id: `m${n}`, name: `m${n}`, description: 'd', content: `alpha ${n}\n${'beta gamma delta. '.repeat(120)}` }) as never
  const r = renderHits([long(1), long(2), long(3), long(4)], (l) => (l.includes('alpha') ? 1 : 0), 2_400, '## h')
  assert.equal(r.included.length, 4)
  assert.equal(r.dropped, 0)
  assert.equal(r.trimmed.length, 4)
  assert.ok(r.bytes <= 2_400)
})

// ── F2: a repeat is passed over, and only use counts as usage ───────────────

test('F2: a memory already shown to this session is not shown again; another session still gets it', () => {
  const { ctx } = fixture()
  const first = prompt(ctx, 'how does the Acme site deck publish?')
  assert.match(first, /acme-site-publish/)
  const again = prompt(ctx, 'and the Acme site deck side panels, how do those publish?')
  assert.doesNotMatch(again, /acme-site-publish/, 'still in this session\'s context')
  assert.match(prompt(ctx, 'and the Acme site deck side panels, how do those publish?', 's2'), /acme-site-publish/)
})

test('F2: shown is not used: usage is recorded only when the reply uses what it was shown', async () => {
  const { gradeShown } = await import('../server/surfacing.js')
  const { store, ctx, dataDir } = fixture()
  prompt(ctx, 'what is the pricing calculator idea again?')
  assert.deepEqual(gradeShown(store, dataDir, 's1', 'I am not sure, let me look at the stock.', Date.now()), [])
  prompt(ctx, 'what was the pricing calculator idea, the one for live stock?', 's3')
  const used = gradeShown(store, dataDir, 's3', 'It is a pricing calculator for Acme that quotes orders from live stock levels, with a demo.', Date.now())
  assert.deepEqual(used, ['idea-acme-pricing-calculator-id'])
  const rels = store.observedEdges('idea-acme-pricing-calculator-id').map((e) => `${e.rel}:${e.dst}`).sort()
  assert.deepEqual(rels, ['surfaced_in:s1', 'surfaced_in:s3', 'used_in:s3'])
})

// ── F3: a floor on relevance itself, not only relative to the best hit ──────

test('F3: a prompt that matches nothing gets nothing, however recent or used the memories are', () => {
  const { ctx, dataDir } = fixture()
  assert.equal(prompt(ctx, 'how much whey should go in the shaker before the oatmeal?'), '')
  assert.equal(prompt(ctx, 'ok, both are in'), '', 'stopwords alone are never evidence')
  const rows = logRows(dataDir)
  assert.ok(rows.every((r: { shown: string[] }) => r.shown.length === 0))
})

test('F3: one chance word in a body is not evidence; the same word in the name is', async () => {
  const { clearsFloor } = await import('../server/relevance.js')
  assert.equal(clearsFloor({ score: 0.5, matched: 1, inHead: false, topical: true }, 0.2), false)
  assert.equal(clearsFloor({ score: 0.5, matched: 1, inHead: true, topical: true }, 0.2), true)
  assert.equal(clearsFloor({ score: 0.12, matched: 3, inHead: true, topical: true }, 0.2), true, 'a long query names the subject')
  assert.equal(clearsFloor({ score: 0.12, matched: 3, inHead: false, topical: true }, 0.2), false)
  assert.equal(clearsFloor({ score: 1, matched: 2, inHead: true, topical: false }, 0.2), false)
})

// ── F6: a role named by department resolves to who holds it ─────────────────

test('F6: titles are read from tables and prose', async () => {
  const { extractPeople } = await import('../server/entities.js')
  const got = (s: string) => extractPeople(s).map((p) => `${p.name}=${p.title}`)
  assert.deepEqual(got('| Role | Name |\n| --- | --- |\n| **CMO** | Dana Quill |\n| VP of Sales | Ana Bell |'), ['Dana Quill=CMO', 'Ana Bell=VP of Sales'])
  assert.deepEqual(got('We met Rob Kane (CMO) and Jo Park, our Chief Technology Officer.'), ['Rob Kane=CMO', 'Jo Park=Chief Technology Officer'])
  assert.deepEqual(got('CFO: Sam Ortiz signed. The new CTO Lee Okafor starts Monday.'), ['Sam Ortiz=CFO', 'Lee Okafor=CTO'])
  assert.deepEqual(got('The Acme Site Publish job runs nightly.'), [])
})

test('F6 replay: "marketing side... which c-suite exec?" reaches the roster and shows the CMO row', () => {
  const { ctx, dataDir } = fixture()
  const out = prompt(ctx, 'on the marketing side at Acme, which c-suite exec owns it?')
  assert.match(out, /acme-leadership-announced/)
  assert.match(out, /\| CMO \| Dana Quill \|/)
  const row = logRows(dataDir)[0]
  assert.ok(row.expanded >= 2, 'marketing and c-suite resolved')
  assert.equal(row.hits[0].id, 'acme-leadership-announced-id', 'ranked first')
})

test('F6: a role word with no one holding it resolves to nothing and changes nothing', async () => {
  const { resolveRoles } = await import('../server/subjects.js')
  const { store } = fixture()
  assert.equal(resolveRoles(store, ['security', 'deck']).byTerm.size, 0)
})

test('F3: a turn that holds only harness text (a task notification, a reminder) recalls nothing', async () => {
  const { userText } = await import('../server/on-user-prompt.js')
  const { ctx, dataDir } = fixture()
  const note = '<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: comms</summary>\n<event>[comms] PM -> dev: the Acme leadership deck and the pricing calculator</event>\n</task-notification>'
  assert.equal(prompt(ctx, note), '')
  assert.equal(prompt(ctx, `<system-reminder>\nthe Acme site deck publishes nightly\n</system-reminder>`), '')
  assert.ok(!fs.existsSync(path.join(dataDir, RECALL_LOG)), 'not even a row: there was no query')
  assert.equal(userText('<command-name>/cortex-memory</command-name>\n<command-args>recall acme roster</command-args>'), 'recall acme roster')
  assert.equal(userText(`${note}\nwho is the CMO at Acme?`), 'who is the CMO at Acme?')
})

// ── F4: a constraint travels with its subject ──────────────────────────────

test('F4: constraint statements are read with the sentence that names their subject', async () => {
  const { constraintLines, constraintKeys } = await import('../server/constraints.js')
  const lines = constraintLines('Agreed: the deck goes to Sam by Friday.\nThe pricing calculator is under embargo. Don\'t share it with Sam yet.\n| CMO | Dana |')
  assert.deepEqual(lines, ["The pricing calculator is under embargo. Don't share it with Sam yet."])
  const keys = constraintKeys(lines[0]!)
  assert.ok(keys.includes('p:sam') && keys.includes('b:pricing_calculator'), keys.join(' '))
  assert.ok(!keys.some((k) => k.includes('don')), 'no contraction fragments')
})

test('F4 replay: the calculator idea comes with the call outcome\'s "don\'t share it with Sam"', () => {
  const { ctx } = fixture()
  const out = prompt(ctx, 'what is the pricing calculator idea again?')
  assert.match(out, /idea-acme-pricing-calculator/)
  assert.match(out, /Don't share it with Sam yet/)
})

test('F4 replay: writing the deck for Sam brings the constraint, whatever the file type; once per stretch', async () => {
  const { default: onPreTool } = await import('../server/on-pre-tool-constraints.js')
  const { ctx } = fixture()
  const write = (session: string) =>
    (onPreTool({ tool_name: 'Write', session_id: session, tool_input: { file_path: '/work/acme/budget-deck.html', content: '<h2>Next steps</h2><p>Pricing calculator demo for Sam</p>' } }, ctx) as { additionalContext?: string } | undefined)?.additionalContext ?? ''
  const first = write('w1')
  assert.match(first, /Don't share it with Sam yet/)
  assert.match(first, /reminder, not a block/)
  assert.equal(write('w1'), '', 'already in front of this session')
  assert.match(write('w2'), /Don't share it with Sam yet/)
  const r = onPreTool({ tool_name: 'Write', session_id: 'w3', tool_input: { file_path: '/work/notes/groceries.md', content: 'milk, eggs, coffee' } }, ctx)
  assert.equal(r, undefined, 'nothing applies, nothing said')
})

test('F4: private places stay in their own cwd; pay terms only on the machines named for them', async () => {
  const { applicableConstraints } = await import('../server/constraints.js')
  const { indexSubjects } = await import('../server/subjects.js')
  const { store, add } = fixture()
  add('northwind-board-note', 'The bid amount is confidential. Never share it with Riley before the meeting.', { scope: '-mnt-data-Projects-northwind' })
  add('sam-rate-note', "Sam's day rate is private. Don't mention the rate to Riley.")
  indexSubjects(store)
  const privacy = { privatePlaces: ['northwind', 'contoso'], compensationOn: ['node-b'] }
  const texts = ['email to Riley about the meeting and the rate']
  const at = (cwd: string, machine: string) => applicableConstraints(store, { texts, cwd, machine: [machine], privacy }).map((c) => c.name)
  assert.deepEqual(at('/home/c/work', 'node-a'), [])
  assert.deepEqual(at('/mnt/data/Projects/northwind', 'node-a'), ['northwind-board-note'])
  assert.deepEqual(at('/home/c/work', 'node-b-wsl'), ['sam-rate-note'])
})

test('a recalled memory says which project it came from; a user-wide one needs no label', async () => {
  const { renderHits } = await import('../server/inject.js')
  const { store, add } = fixture()
  add('order-layout', 'Orders ship as one service per tenant.', { scope: '-mnt-data-Projects-northwind-Northwind.Api.Orders' })
  add('long-order-notes', Array.from({ length: 80 }, (_, i) => `Order note ${i}: tenants keep their own queue.`).join('\n'), { scope: '-mnt-data-Projects-northwind' })
  add('tea', 'Green tea at 80 C.')
  const text = renderHits(store.all(), () => 1, 2400, 'H').text
  const headOf = (name: string) => text.split('\n').find((l) => l.startsWith(`- **${name}`)) ?? ''
  assert.match(headOf('order-layout'), /\(from -mnt-data-Projects-northwind-Northwind\.Api\.Orders\)/)
  assert.match(headOf('long-order-notes'), /\(from -mnt-data-Projects-northwind\)/, 'an excerpt keeps it too')
  assert.doesNotMatch(headOf('tea'), /\(from /)
})

test('feedback adopted from another machine is filed user-wide, and still says the project it came from', async () => {
  const { originOf } = await import('../server/inject.js')
  assert.equal(originOf({ scope: 'user', source: 'NODE-B-x:/home/c/.claude/projects/-mnt-data-Projects-northwind/memory/no-friday-deploys.md' }), ' (from -mnt-data-Projects-northwind)')
  assert.equal(originOf({ scope: 'user', source: '/home/c/.claude/memory/tea.md' }), '', 'user-wide by where it was written: no label')
  assert.equal(originOf({ scope: '-srv-repos-app', source: '/x.md' }), ' (from -srv-repos-app)')
})

// ── F5: recall before asking the user a fact ───────────────────────────────

test('F5: only a closing factual question counts; decisions and answered questions pass', async () => {
  const { closingQuestion } = await import('../server/on-stop-ask.js')
  assert.equal(closingQuestion('Slide 3 covers marketing.\n\nWho runs marketing at Acme?'), 'Who runs marketing at Acme?')
  assert.equal(closingQuestion('Plan is ready. Should I go ahead?'), null)
  assert.equal(closingQuestion('Which option do you prefer?'), null)
  assert.equal(closingQuestion('Who owns it? Sam does, per the call.'), null)
  assert.equal(closingQuestion('Done.\n```\nwho am i?\n```'), null)
})

test('F5 replay: asking who runs marketing goes back once with the roster', async () => {
  const { default: onStopAsk } = await import('../server/on-stop-ask.js')
  const { ctx, dataDir } = fixture()
  const reply = 'I put marketing on slide 3 of the deck.\n\nWho runs marketing at Acme, so I can name them?'
  const r = onStopAsk({ session_id: 'a1', last_assistant_message: reply }, ctx) as { decision?: string; reason?: string }
  assert.equal(r?.decision, 'deny', 'Stop turns a deny into decision: block')
  assert.match(r.reason!, /\| CMO \| Dana Quill \|/)
  assert.equal(onStopAsk({ session_id: 'a1', last_assistant_message: reply, stop_hook_active: true }, ctx), undefined, 'never twice')
  assert.equal(onStopAsk({ session_id: 'a1', last_assistant_message: 'What time is your flight tomorrow?' }, ctx), undefined, 'memory has nothing: ask')
  assert.ok(logRows(dataDir).some((row: { event: string }) => row.event === 'ask'))
})

// ── F7: a session starts knowing who is in play and what not to do ─────────

test('F7: session start lists live constraints with their subjects; private places and pay terms stay where they belong', async () => {
  const { activeSubjects, renderActiveSubjects } = await import('../server/constraints.js')
  const { indexSubjects } = await import('../server/subjects.js')
  const { store, add } = fixture()
  const old = Date.now() - 60 * 24 * 60 * 60 * 1000
  add('old-vendor-note', 'Never cc Quinn on vendor threads.', { authoredAt: old, ingestedAt: old })
  add('project-rule', 'Never deploy the Orbit site on a Friday without Kim.', { authoredAt: old, ingestedAt: old, scope: '-work-orbit' })
  add('northwind-note', 'The bid amount is confidential. Never share it with Riley.', { scope: '-mnt-data-Projects-northwind' })
  add('rate-note', "Sam's day rate is private. Don't mention the rate to Riley.")
  indexSubjects(store)
  const privacy = { privatePlaces: ['northwind', 'contoso'], compensationOn: ['node-b'] }
  const at = (cwd: string, machine = 'node-a') => activeSubjects(store, { cwd, machine: [machine], privacy, asOf: Date.now() }).map((s) => s.name)
  const elsewhere = at('/home/c/misc')
  assert.ok(elsewhere.includes('acme-call-outcome'), 'recent: the Sam embargo')
  assert.ok(!elsewhere.includes('old-vendor-note'), 'old and out of scope')
  assert.ok(!elsewhere.includes('project-rule'), 'another project')
  assert.ok(!elsewhere.includes('northwind-note') && !elsewhere.includes('rate-note'))
  assert.ok(at('/work/orbit').includes('project-rule'), 'this project, however old')
  assert.ok(at('/mnt/data/Projects/northwind').includes('northwind-note'))
  assert.ok(at('/home/c/misc', 'node-b').includes('rate-note'))
  const text = renderActiveSubjects(activeSubjects(store, { cwd: '/home/c/misc', machine: ['x'], privacy, asOf: Date.now() }))
  assert.match(text, /- Sam: The pricing calculator is under embargo\. Don't share it with Sam yet\. \(from acme-call-outcome\)/)
})

// ── F6b: an empty or weak first pass is asked again, as titles and names ────

test('F6b replay: every phrasing of the marketing question reaches the CMO row', () => {
  const { ctx } = fixture()
  const phrasings = [
    'who runs marketing at Acme?',
    'who is the head of marketing over there?',
    'the Acme marketing exec, who is that?',
    'on the marketing side at Acme, which c-suite exec owns it?',
  ]
  phrasings.forEach((q, i) => assert.match(prompt(ctx, q, `p${i}`), /\| CMO \| Dana Quill \|/, q))
})

test('F6b: a weak first pass is re-asked with role synonyms, and both passes are logged', () => {
  const { ctx, add, dataDir } = fixture()
  add('note-0412', 'The CMO wants the product launch moved to May so the campaign lands first.')
  const out = prompt(ctx, 'what does the marketing lead think about the launch timing?', 'q1')
  assert.match(out, /note-0412/)
  const rows = logRows(dataDir).filter((r: { session: string }) => r.session === 'q1')
  assert.deepEqual(rows.map((r: { pass?: number }) => r.pass), [1, 2])
  assert.equal(rows[0].shown.length, 0)
})

test('F6b: when the expanded query is still empty, nothing is injected', () => {
  const { ctx, dataDir } = fixture()
  assert.equal(prompt(ctx, 'who runs security for the warehouse cameras?', 'q2'), '')
  const rows = logRows(dataDir).filter((r: { session: string }) => r.session === 'q2')
  assert.deepEqual(rows.map((r: { pass?: number }) => r.pass), [1, 2])
  assert.ok(rows.every((r: { shown: string[] }) => r.shown.length === 0))
})

test('F4: with no privacy.json, pay-type constraints show on no machine', async () => {
  const { loadPrivacy, machineAllowsCompensation } = await import('../server/constraints.js')
  const { dataDir } = fixture()
  const privacy = loadPrivacy(dataDir)
  assert.deepEqual(privacy.compensationOn, [])
  assert.equal(machineAllowsCompensation(['node-b-c5e3af1c', 'any-host'], privacy), false)
})

test('with no privacy.json, no place is private: the module names none', async () => {
  const { loadPrivacy, placeAllowed } = await import('../server/constraints.js')
  const { dataDir } = fixture()
  const privacy = loadPrivacy(dataDir)
  assert.deepEqual(privacy.privatePlaces, [])
  assert.equal(placeAllowed({ scope: '-mnt-data-Projects-northwind', source: '' }, '/srv/cortex/elsewhere', privacy), true)
  fs.writeFileSync(path.join(dataDir, 'privacy.json'), JSON.stringify({ privatePlaces: ['contoso'] }))
  assert.equal(placeAllowed({ scope: '-home-alex-contoso-bid-tool', source: '' }, '/srv/cortex/elsewhere', loadPrivacy(dataDir)), false)
})

test('F4 regression (live on node-a): a fact with "don\'t", a shouted word and a code fragment are not constraints on outbound text', async () => {
  const { constraintLines, constraintKeys } = await import('../server/constraints.js')
  assert.deepEqual(constraintLines("The account list needs LIST.READ, which the key lacks and we don't need."), [])
  assert.deepEqual(constraintLines("Quote the heredoc (`<<'EOF'`), never an unquoted `echo`."), [])
  const rule = constraintLines('A harness that WRITES never points at production.')
  assert.equal(rule.length, 1, 'a rule is still a rule')
  assert.ok(!constraintKeys(rule[0]!).some((k) => k.startsWith('p:')), 'WRITES is emphasis, not a name')
  assert.deepEqual(constraintLines("Please don't forward this to Riley."), ["Please don't forward this to Riley."])

  const { default: onPreTool } = await import('../server/on-pre-tool-constraints.js')
  const { ctx, add } = fixture()
  add('harness-rule', 'A harness that WRITES never points at production.')
  const send = 'node bin/cortex-role.ts send pm "read-only query, it writes the derived tables, then production deploy"'
  assert.equal(onPreTool({ tool_name: 'Bash', session_id: 'b1', tool_input: { command: send } }, ctx), undefined, 'no name in common: nothing applies')
})

test('F4 regression (live on node-a): paths and the running user are never the subject', async () => {
  const { contextKeys } = await import('../server/constraints.js')
  const keys = contextKeys(['cp /home/alex/work/x.md /tmp/claude-1000/scratch/y.md and tell Riley'])
  assert.ok(keys.has('p:riley'))
  assert.ok(!keys.has('p:alex') && !keys.has('p:claude') && !keys.has('p:scratch'), [...keys].join(' '))
  const { outgoing } = await import('../server/on-pre-tool-constraints.js')
  const text = outgoing({ tool_name: 'Write', tool_input: { file_path: '/home/someone/clients/acme/budget-deck.html', content: 'x' } })!
  assert.match(text, /acme budget deck html/, 'the client folder still counts')
  assert.doesNotMatch(text, /someone|clients\b.*home/)
})

test('F5 regression (live on node-a): a permission question passes; a factual "can" does not', async () => {
  const { closingQuestion } = await import('../server/on-stop-ask.js')
  assert.equal(closingQuestion('Rehearsal is waiting. Can Northwind records leave node-b?'), null)
  assert.equal(closingQuestion('Is it ok to publish the deck to Sam?'), null)
  assert.equal(closingQuestion('Are we allowed to send it before Friday?'), null)
  assert.equal(closingQuestion('Can the API take 10k users at once?'), 'Can the API take 10k users at once?')
})

test('F5 regression (live on node-a): a bounce needs a hit that covers the question, not one shared word', async () => {
  const { default: onStopAsk } = await import('../server/on-stop-ask.js')
  const { ctx, add } = fixture()
  add('vendor-host-notes', 'The Acme vendor host is reachable only from the office network.')
  const r = onStopAsk({ session_id: 'a2', last_assistant_message: 'Done with the slides. Which quarter does the Acme renewal fall in?' }, ctx)
  assert.equal(r, undefined, 'shares "Acme" only: ask the user')
})

// ── the constraint relevance gate ────────────────────────────────────────────

test('gate: one ordinary word is not enough; a known person, a shown subject, or two keys in scope are', async () => {
  const { applicableConstraints } = await import('../server/constraints.js')
  const { indexSubjects } = await import('../server/subjects.js')
  const { store, add } = fixture()
  add('linear-rule', 'Never post to Linear without approval.')
  add('orbit-rule', 'Never deploy Orbit on a Friday without Kim.', { scope: '-work-orbit' })
  add('cc-rule', 'Never cc Orbit on vendor mail.')
  indexSubjects(store)
  const privacy = { privatePlaces: [], compensationOn: [] }
  const gate = (scope?: string) => ({ people: store.peopleTokens(), ...(scope ? { scope } : {}) })
  const names = (texts: string[], scope?: string, topics: string[] = []) =>
    applicableConstraints(store, { texts, topics, machine: ['x'], privacy, gate: gate(scope), textPhrases: true }).map((c) => c.name)

  assert.deepEqual(names(['plan a linear progression for the game levels']), [], '"linear" the word')
  assert.deepEqual(names(['the deck is for Sam']), ['acme-call-outcome'], 'Sam is a known person')
  assert.deepEqual(names(['orbit is fine, ask kim about the release']), [], 'another project, ordinary keys only')
  assert.deepEqual(names(['orbit is fine, ask kim about the release'], '-work-orbit'), ['orbit-rule'], 'its own project: two keys will do')
  assert.deepEqual(names(['can we deploy orbit today?']), ['orbit-rule'], 'its own phrase in the prompt is evidence from anywhere')
  const calculator = ['idea acme pricing calculator\nPricing calculator idea for Acme']
  assert.deepEqual(names(['what next?'], undefined, calculator), [], 'what recall showed is not evidence by itself')
  assert.deepEqual(names(['what is the pricing calculator idea again?']), ['acme-call-outcome'], 'a phrase of the prompt the constraint uses')
  assert.deepEqual(names(['draft the orbit mail']), [], 'one name in the prompt, nothing else')
  assert.deepEqual(names(['draft the orbit mail'], undefined, ['orbit release plan\nThe Orbit release, step by step']), ['cc-rule'], 'a name in the prompt that a shown subject corroborates')
})

test('gate: at most two constraints at prompt time', async () => {
  const { ctx, add } = fixture()
  for (const n of [1, 2, 3, 4]) add(`sam-rule-${n}`, `Never forward Sam the vendor quote ${n}.`)
  const out = prompt(ctx, 'send the budget deck to Sam today', 'g1')
  const block = out.split('## Cortex — possibly relevant')[0]!
  assert.equal((block.match(/^- /gm) ?? []).length, 2)
})

// ── after a compaction: the session's own working set ──────────────────────

test('restore: after a compaction the session gets back what it wrote, used and was shown; never otherwise', async () => {
  const { sweep } = await import('../server/sweep.js')
  const { Journal } = await import('../server/journal.js')
  const { gradeShown } = await import('../server/surfacing.js')
  const { restoreBlock } = await import('../server/on-session.js')
  const { store, ctx, dataDir } = fixture()
  const memoryDir = fs.mkdtempSync(path.join(dataDir, 'mem-'))
  fs.writeFileSync(path.join(memoryDir, 'deck-thread.md'), '---\nname: deck-thread\ndescription: Budget deck for Sam, slides 1-6 done\ntype: thread\n---\n\nNext: the appendix.\n')
  fs.writeFileSync(path.join(memoryDir, 'deck-colours.md'), '---\nname: deck-colours\ndescription: The deck uses the Acme navy palette\n---\n\nNavy and white only.\n')
  const journal = new Journal({ dir: path.join(dataDir, 'journal'), machine: 'node-a' })
  sweep({ memoryDir, scope: 'user', machine: 'node-a', sessionId: 'r1' }, { store, journal })

  prompt(ctx, 'what is the pricing calculator idea again?', 'r1')
  gradeShown(store, dataDir, 'r1', 'It is a pricing calculator for Acme that quotes orders from live stock levels.', Date.now())
  const { applicableConstraints, markConstraintsShown } = await import('../server/constraints.js')
  const shown = applicableConstraints(store, { texts: ['the deck for Sam'], machine: ['x'], privacy: { privatePlaces: [], compensationOn: [] } })
  markConstraintsShown(dataDir, 'r1', shown, Date.now())

  const after = restoreBlock(ctx, { session_id: 'r1', source: 'compact' })
  assert.match(after, /restored after compaction/)
  assert.match(after, /Threads this session wrote:\*\*\n- deck-thread — Budget deck for Sam/)
  assert.match(after, /Decisions and notes this session wrote:\*\*\n- deck-colours/)
  assert.match(after, /Memories this session used:\*\*\n- idea-acme-pricing-calculator/)
  assert.match(after, /Constraints this session was shown:\*\*\n- The pricing calculator is under embargo/)
  assert.equal(restoreBlock(ctx, { session_id: 'r1', source: 'startup' }), '', 'only after a compaction')
  assert.equal(restoreBlock(ctx, { session_id: 'other', source: 'compact' }), '', 'another session has nothing of this one')
})
