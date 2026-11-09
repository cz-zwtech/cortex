import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

import { ingest } from '../server/ingest.js'
import { Journal } from '../server/journal.js'
import { audit, lastReply, noteTarget, outboundText, takeTarget } from '../server/ruleAudit.js'
import { readFires, review } from '../server/ruleReview.js'
import { checkText, namedTarget, renderRulesMd, ruleOf, type Rule } from '../server/rules.js'
import { MemoryStore } from '../server/store.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-rules-'))
  dirs.push(d)
  return d
}

const TODO_RULE = `---
name: no-todo
kind: rule
category: voice-and-writing
why: a TODO reads as unfinished work
source: [[feedback-no-todo]]
scope: user
valid: always
when: always
do: No TODO in shipped text
check: regex:\\bTODO\\b
enforce: audit
---
A TODO left in shipped text reads as unfinished work.
`
const rule = (over: Partial<Rule> = {}): Rule => ({ ...ruleOf(TODO_RULE)!, id: 'r1', name: 'no-todo', ...over })

test('ruleOf reads the flat front matter; a memory that is not kind: rule is not a rule', () => {
  const r = ruleOf(TODO_RULE)!
  assert.equal(r.why, 'a TODO reads as unfinished work')
  assert.deepEqual(r.source, ['feedback-no-todo'])
  assert.equal(r.scope, 'user')
  assert.equal(r.check, 'regex:\\bTODO\\b')
  assert.equal(r.enforce, 'audit')
  assert.equal(ruleOf('---\nname: x\ntype: feedback\n---\nbody'), null)
  assert.equal(ruleOf(TODO_RULE.replace('enforce: audit', 'enforce: maybe'))!.enforce, 'remind', 'an unknown mode falls back to remind')
})

test('rules.md: always-on rules only, one line each WITH the reason, grouped; role lines under their role; never empty', () => {
  const md = renderRulesMd([
    rule(),
    rule({ id: 'r2', name: 'release-notes-list', scope: 'role:pm', category: 'ops', do: 'Update docs/release-notes.md', why: 'it is the shared list' }),
    rule({ id: 'r3', name: 'squash-merges', scope: 'repo:sample-app', when: 'tool:Bash', do: 'Squash before merging', why: 'x' }),
    rule({ id: 'r4', name: 'proj-orchid', scope: 'client:acme', valid: 'until: orchid launches', do: 'Roles, not names', why: 'y' }),
  ])
  assert.match(md, /### Voice and writing\n- No TODO in shipped text \(a TODO reads as unfinished work\)/)
  assert.match(md, /### If this session is in role pm\n- Update docs\/release-notes\.md \(it is the shared list\)/)
  assert.doesNotMatch(md, /Squash before merging|Roles, not names/, 'scoped and time-bound rules are not always-on')
  assert.match(renderRulesMd([]), /\(No always-on rules yet\.\)/, 'an empty set still writes text: a missing import is skipped silently')
})

test('check: quotes and code are exempt; a TODO elsewhere is found with its place', () => {
  const text = 'Hi team TODO quick note.\n> "quoted TODO kept"\nShe said “keep it TODO exactly”.\n`a TODO b` and\n```\ncode TODO here\n```\nDone.'
  const v = checkText(text, [rule()])
  assert.deepEqual(v.map((x) => [x.line, x.col]), [[1, 9]])
})

test('a kind: rule memory is a rule in the store after ingest; forget and an edit that drops kind both clear it', () => {
  const d = tmp()
  const db = new Database(':memory:')
  db.exec(schema)
  const store = new MemoryStore(db)
  const deps = { store, journal: new Journal({ dir: path.join(d, 'j'), machine: 'm' }) }
  const input = (content: string) => ({ slug: 'no-todo', source: path.join(d, 'r.md'), scope: 'user', machine: 'm', authoredAt: 1, content, body: content.replace(/^---[\s\S]*?---\n/, '') })
  const r = ingest(input(TODO_RULE) as never, deps) as { receipt: { id: string } }
  assert.deepEqual(store.rules().map((x) => [x.name, x.enforce]), [['no-todo', 'audit']])
  ingest(input(TODO_RULE.replace('kind: rule\n', '')) as never, deps)
  assert.deepEqual(store.rules(), [], 'no longer a rule')
  ingest(input(TODO_RULE) as never, deps)
  store.delete(r.receipt.id)
  assert.deepEqual(store.rules(), [], 'forgotten')
})

test('outbound text: prose writes, sends and messaging tools; code files and other commands are not', () => {
  assert.equal(outboundText({ tool_name: 'Write', tool_input: { file_path: '/x/notes.md', content: 'hi' } })?.what, 'Write notes.md')
  assert.equal(outboundText({ tool_name: 'Write', tool_input: { file_path: '/x/app.ts', content: 'a TODO b' } }), null)
  assert.equal(outboundText({ tool_name: 'Edit', tool_input: { file_path: '/x/README.md', new_string: 'x' } })?.text, 'x')
  const send = outboundText({ tool_name: 'Bash', tool_input: { command: "tsx bin/cortex-role.ts send pm --body-file - <<'EOF'\nHello TODO there\nEOF" } })
  assert.deepEqual(send, { what: 'outbound send (Bash)', text: 'Hello TODO there', audience: 'internal' })
  assert.equal(outboundText({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }), null)
  assert.equal(outboundText({ tool_name: 'mcp__slack__send_message', tool_input: { text: 'yo' } })?.text, 'yo')
})

test('audit logs one fire per checkable rule, clean or violated, and never blocks', () => {
  const log = path.join(tmp(), 'fires.jsonl')
  assert.equal(audit('Plain text.', [rule()], log, { session: 's1', event: 'PreToolUse', what: 'Write a.md' }), 0)
  assert.equal(audit('A TODO B TODO C', [rule(), rule({ id: 'm', name: 'manual-one', check: 'manual' })], log, { event: 'Stop', what: 'chat reply for slack' }), 2)
  assert.deepEqual(readFires(log).map((f) => [f.rule, f.outcome, f.findings]), [
    ['no-todo', 'audited-clean', 0],
    ['no-todo', 'audited-violation', 2],
  ])
})

test('the Stop audit: a prompt naming a target is noted once; the last reply is read from the transcript tail', () => {
  const d = tmp()
  assert.equal(namedTarget('Draft a Slack message to the team'), 'slack')
  assert.equal(namedTarget('write a note to Riley thanking him'), 'person')
  assert.equal(namedTarget('fix the failing test'), undefined)
  noteTarget(d, 's1', 'WhatsApp to Todd about billing')
  assert.equal(takeTarget(d, 's1'), 'whatsapp')
  assert.equal(takeTarget(d, 's1'), undefined, 'once')
  noteTarget(d, 's1', 'email to Riley')
  noteTarget(d, 's1', 'now run the tests')
  assert.equal(takeTarget(d, 's1'), undefined, 'a later prompt without a target clears it')

  const t = path.join(d, 't.jsonl')
  fs.writeFileSync(t, [
    JSON.stringify({ type: 'user', message: { content: 'draft it' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi Todd, here it is. TODO attach the file.' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'x' }] } }),
  ].join('\n') + '\n')
  assert.equal(lastReply(t), 'Hi Todd, here it is. TODO attach the file.')
})

test('review: conditions to re-check, lost reasons, violations, noise and staleness', () => {
  const log = path.join(tmp(), 'fires.jsonl')
  const now = Date.parse('2026-10-20T12:00:00Z')
  audit('A TODO B', [rule()], log, { event: 'Stop', what: 'chat reply for slack' }, now)
  const lines = review(
    [
      rule(),
      rule({ id: 'h', name: 'proj-orchid', valid: 'until: orchid launches', reviewBy: '2026-10-01', source: ['gone-memory'], when: 'text_for:orchid', check: 'manual' }),
    ],
    log,
    { days: 30, now, sourceExists: (n) => n !== 'gone-memory' },
  ).join('\n')
  assert.match(lines, /proj-orchid: until: orchid launches \(review by 2026-10-01, DUE\)/)
  assert.match(lines, /proj-orchid: sources gone-memory not found/)
  assert.match(lines, /no-todo: 1 of 1 checks found something \(latest: chat reply for slack\)/)
  assert.match(lines, /Stale[^\n]*\n  - proj-orchid: when text_for:orchid/)
})

test('a source link resolves by front-matter name or by file name', () => {
  const db = new Database(':memory:')
  db.exec(schema)
  const store = new MemoryStore(db)
  store.upsert({ id: 'a', source: '/m/feedback_no_coauthor.md', name: 'No co-authored-by in commits', description: '', content: 'x', shape: 'feedback', authorship: 'authored', scope: 'user', pinned: false, protected: false, machine: 'm', authoredAt: 1, ingestedAt: 1, outcome: '', outcomeText: '' } as never)
  assert.equal(store.hasMemoryNamed('feedback_no_coauthor'), true)
  assert.equal(store.hasMemoryNamed('No co-authored-by in commits'), true)
  assert.equal(store.hasMemoryNamed('something-else'), false)
})

test('RULES NEVER FOLD: two rule files with the same body, and a rule whose body matches an ordinary memory, each stay their own rule', () => {
  // Rules migrated together can share one body; folded by exact body hash, all but the first would lose
  // their rule fields while the sweep still reported them ingested.
  const d = tmp()
  const db = new Database(':memory:')
  db.exec(schema)
  const store = new MemoryStore(db)
  const deps = { store, journal: new Journal({ dir: path.join(d, 'j'), machine: 'm' }) }
  const body = 'Carried over from the old block. The reason is a draft.\n'
  const file = (name: string, kind: string) => `---\nname: ${name}\n${kind}description: x\n---\n${body}`
  const input = (name: string, content: string) => ({ slug: name, source: path.join(d, `${name}.md`), scope: 'user', machine: 'm', authoredAt: 1, content, body })
  ingest(input('engage-old', file('engage-old', '')) as never, deps) // an ordinary memory with the same body
  const a = ingest(input('rule-a', file('rule-a', 'kind: rule\ndo: A\n')) as never, deps) as { receipt: { action: string } }
  const b = ingest(input('rule-b', file('rule-b', 'kind: rule\ndo: B\n')) as never, deps) as { receipt: { action: string } }
  assert.notEqual(a.receipt.action, 'fold')
  assert.notEqual(b.receipt.action, 'fold')
  assert.deepEqual(store.rules().map((r) => [r.name, r.do]), [['rule-a', 'A'], ['rule-b', 'B']])
})

test('ruleOf reads a rule whose fields the harness normaliser nested under metadata:, top level winning', () => {
  const nested = [
    '---',
    'name: use-forever-not-beta',
    'description: Install from the forever channel',
    'metadata:',
    '  kind: rule',
    '  why: the beta channel breaks saved settings',
    '  when: path:installs/**',
    '  do: install from the forever channel, never beta',
    '  enforce: deny',
    '---',
    '',
    'Body.',
  ].join('\n')
  const r = ruleOf(nested)
  assert.ok(r, 'a nested rule is a rule, not a plain observation')
  assert.equal(r!.do, 'install from the forever channel, never beta')
  assert.equal(r!.when, 'path:installs/**')
  assert.equal(r!.enforce, 'deny')
  const both = nested.replace('metadata:\n', 'enforce: remind\nmetadata:\n')
  assert.equal(ruleOf(both)!.enforce, 'remind', 'a top-level field wins over a nested one')
})

test('reindex gives a rule back to a memory ingested before nested fields were read', async () => {
  const { reindex } = await import('../server/reindex.js')
  const db = new Database(':memory:')
  db.exec(schema)
  const store = new MemoryStore(db)
  const journal = new Journal({ dir: path.join(tmp(), 'journal'), machine: 'mach-a' })
  const content = '---\nname: use-forever\ndescription: forever channel\nmetadata:\n  kind: rule\n  do: install from the forever channel\n  enforce: deny\n---\n\nBody.\n'
  const r = ingest({ content, body: 'Body.', slug: 'use-forever', scope: 'user', source: '/m/use-forever.md', machine: 'mach-a', authoredAt: 1 }, { store, journal })
  assert.equal(r.status, 'ingested')
  const id = r.status === 'ingested' ? r.receipt.id : ''
  store.setRule(id, null) // as the old ingest left it: a plain observation
  assert.equal(store.rules().length, 0)
  assert.equal(reindex(store, journal, false).changed, 1, 'a dry run sees it')
  assert.equal(store.rules().length, 0, 'and changes nothing')
  reindex(store, journal, true)
  assert.deepEqual(store.rules().map((x) => [x.name, x.enforce]), [['use-forever', 'deny']])
  assert.equal(reindex(store, journal, false).changed, 0, 'nothing left to fix')
})
