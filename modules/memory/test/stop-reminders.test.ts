/**
 * The lesson and ask Stop checks leave a reminder for the next prompt instead of
 * holding the turn (core/pendingReminders.ts, on-prompt-reminders.ts); the outbound
 * audit still holds, worded as a reminder.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import type { ModuleCtx } from '../../../core/ctx.js'
import onPromptReminders from '../server/on-prompt-reminders.js'
import onStopAsk from '../server/on-stop-ask.js'
import onStopAudit from '../server/on-stop-audit.js'
import onStopLesson from '../server/on-stop-lesson.js'
import { noteTarget } from '../server/ruleAudit.js'
import type { Rule } from '../server/rules.js'
import { fixture } from './engagement-fixture.js'

const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const rig = () => {
  const f = fixture()
  dirs.push(f.dataDir)
  const next = (session: string) => (onPromptReminders({ session_id: session, prompt: 'carry on' }, f.ctx) as { additionalContext?: string } | undefined)?.additionalContext
  return { ...f, next }
}

test('lesson: a stated, unrecorded lesson is not held at Stop; the next prompt carries it once, with the sentence', () => {
  const { ctx, next } = rig()
  const reply = 'Merged. Noted, I will not append to stub files again.'
  assert.equal(onStopLesson({ session_id: 'L1', last_assistant_message: reply }, ctx), undefined)
  assert.equal(next('L2'), undefined, 'another session gets nothing')
  const said = next('L1')!
  assert.match(said, /^Cortex reminder from your last reply:/)
  assert.match(said, /stated a lesson \("Noted, I will not append to stub files again\."\)/)
  assert.match(said, /kind: rule/)
  assert.equal(next('L1'), undefined, 'delivered once')
})

test('ask: a factual closing question memory covers is not held at Stop; the next prompt carries it once, naming the memory', () => {
  const { ctx, next } = rig()
  const reply = 'I put marketing on slide 3 of the deck.\n\nWho runs marketing at Acme, so I can name them?'
  assert.equal(onStopAsk({ session_id: 'a1', last_assistant_message: reply }, ctx), undefined)
  const said = next('a1')!
  assert.match(said, /^Cortex reminder from your last reply:/)
  assert.match(said, /asking the user "Who runs marketing at Acme, so I can name them\?"/)
  assert.match(said, /acme-leadership-announced \(acme-leadership-announced-id\)/)
  assert.match(said, /\| CMO \| Dana Quill \|/)
  assert.equal(next('a1'), undefined, 'delivered once')
})

test('audit: a reply for an external target that breaks a deny rule still holds, worded as a reminder', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-audit-'))
  dirs.push(dataDir)
  const rule: Rule = {
    id: 'no-todo-id',
    name: 'no-todo',
    category: 'voice',
    why: 'drafts go out finished',
    source: [],
    scope: 'user',
    valid: 'always',
    when: 'text_for:external',
    do: 'no TODO markers',
    check: 'regex:\\bTODO\\b',
    enforce: 'deny',
  }
  const ctx = { dataDir, log: () => {}, capabilities: { get: () => ({ list: () => [rule] }) } } as unknown as ModuleCtx
  noteTarget(dataDir, 't1', 'draft a slack message to the client about the launch')
  const r = onStopAudit({ session_id: 't1', last_assistant_message: 'Launch is Friday. TODO: confirm the venue.' }, ctx) as { decision?: string; reason?: string }
  assert.equal(r.decision, 'deny')
  assert.match(r.reason!, /^Cortex reminder \(not an error\): Cortex refused this chat reply/)
})
