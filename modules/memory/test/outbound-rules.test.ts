/**
 * Text rules acting on outbound text (ruleAudit.ts judgeOutbound): deny refuses
 * a prose write or a send, and bounces a reply for an external target once;
 * remind shows the matches; a manual-check text_for rule is reminded at the
 * write or send, once per stretch.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { ModuleCtx } from '../../../core/ctx.js'
import onStopAudit from '../server/on-stop-audit.js'
import onToolAudit from '../server/on-tool-audit.js'
import { noteTarget } from '../server/ruleAudit.js'
import { addOverride } from '../server/ruleOverrides.js'
import { readFires } from '../server/ruleReview.js'
import type { Rule } from '../server/rules.js'

const rule = (name: string, over: Partial<Rule>): Rule => ({
  id: `${name}-id`,
  name,
  category: 'voice',
  why: `why for ${name}`,
  source: [],
  scope: 'user',
  valid: 'always',
  when: 'text_for:external',
  do: `do for ${name}`,
  check: 'manual',
  enforce: 'remind',
  ...over,
})

const RULES = [
  rule('no-dashes', { check: 'regex:[—–]', enforce: 'deny' }),
  rule('no-estimates', { check: 'regex:\\b\\d+ (?:days|weeks)\\b', enforce: 'remind' }),
  rule('email-voice', {}),
  rule('quiet', { check: 'regex:zzz', enforce: 'audit' }),
]

const rig = () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-'))
  const ctx = { dataDir, log: () => {}, capabilities: { get: () => ({ list: () => RULES }) } } as unknown as ModuleCtx
  const write = (file: string, content: string, session = 's1') =>
    onToolAudit({ tool_name: 'Write', session_id: session, tool_input: { file_path: file, content } }, ctx) as { decision?: string; reason?: string; additionalContext?: string } | undefined
  return { dataDir, ctx, write, fires: () => readFires(path.join(dataDir, 'rule-fires.jsonl')) }
}

test('deny: a prose write that breaks the rule is refused, quoting the rule and the line; quotes and code are exempt', () => {
  const { write, fires } = rig()
  const r = write('/w/note.md', 'Hello Sam,\nRevenue is up — a lot.\n')!
  assert.equal(r.decision, 'deny')
  assert.match(r.reason!, /no-dashes: do for no-dashes\. Why: why for no-dashes/)
  assert.match(r.reason!, /line 2, col 15: Revenue is up — a lot\./)
  assert.match(r.reason!, /cortex-rules allow no-dashes --once/)
  assert.ok(fires().some((f) => f.rule === 'no-dashes' && f.outcome === 'denied'))
  assert.notEqual(write('/w/note2.md', 'Use `a — b` in code, and "quoted — text".')?.decision, 'deny')
  assert.equal(write('/w/app.ts', 'const s = "a — b"'), undefined, 'not prose: not outbound')
})

test('deny: the user\'s override lets one write through', () => {
  const { dataDir, write, fires } = rig()
  addOverride(dataDir, { rule: 'no-dashes', at: Date.now(), once: true })
  assert.notEqual(write('/w/n.md', 'one — two')?.decision, 'deny')
  assert.equal(write('/w/n.md', 'one — two')?.decision, 'deny')
  assert.deepEqual(fires().filter((f) => f.rule === 'no-dashes' && f.outcome !== 'audited-violation').map((f) => f.outcome), ['overridden', 'denied'])
})

test('remind: a regex rule shows its matches; a manual-check rule is reminded once per stretch', () => {
  const { write } = rig()
  const first = write('/w/plan.md', 'It will take 3 weeks.')!
  assert.equal(first.decision, undefined)
  assert.match(first.additionalContext!, /do for no-estimates\. Why: why for no-estimates\. Matched: line 1, col 14: It will take 3 weeks\./)
  assert.match(first.additionalContext!, /do for email-voice/)
  const again = write('/w/plan.md', 'Nothing to flag here.')
  assert.equal(again, undefined, 'the manual rule waits out its stretch')
  assert.match(write('/w/plan.md', 'Nothing to flag here.', 's2')!.additionalContext!, /email-voice/, 'another session gets it')
})

test('Stop: a reply for an external target that breaks a deny rule goes back once', () => {
  const { dataDir, ctx } = rig()
  const stop = (reply: string, over: Record<string, unknown> = {}) =>
    onStopAudit({ session_id: 't1', last_assistant_message: reply, ...over }, ctx) as { decision?: string; reason?: string } | undefined
  assert.equal(stop('Revenue is up — a lot.'), undefined, 'no external target named')
  noteTarget(dataDir, 't1', 'draft a slack message to the client about revenue')
  const r = stop('Revenue is up — a lot.')!
  assert.equal(r.decision, 'deny')
  assert.match(r.reason!, /this chat reply for .*no-dashes/s)
  noteTarget(dataDir, 't1', 'draft a slack message to the client about revenue')
  assert.equal(stop('Revenue is up — a lot.', { stop_hook_active: true }), undefined, 'the rewrite passes')
  noteTarget(dataDir, 't1', 'draft a slack message to the client about revenue')
  assert.equal(stop('Revenue is up, a lot.'), undefined)
})

test('audience: a bus send is internal, so text_for:external rules skip it; a messaging tool is external', () => {
  const { ctx } = rig()
  const send = (tool_name: string, tool_input: Record<string, unknown>, session: string) =>
    (onToolAudit({ tool_name, session_id: session, tool_input }, ctx) as { additionalContext?: string } | undefined)?.additionalContext ?? ''
  const bus = send('Bash', { command: "node bin/cortex-role.ts send game-dev 'Next: the level editor, about 3 weeks.'" }, 'a1')
  assert.doesNotMatch(bus, /email-voice/, 'internal: the external voice rule stays out')
  assert.doesNotMatch(bus, /no-estimates/, 'and so do the other text_for:external rules')
  const slack = send('mcp__slack__post_message', { text: 'Next: the level editor, about 3 weeks.' }, 'a2')
  assert.match(slack, /email-voice/)
  assert.match(slack, /no-estimates/)
})
