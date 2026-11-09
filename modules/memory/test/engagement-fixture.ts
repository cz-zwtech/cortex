/**
 * Invented memories for the engagement tests: a roster kept in a long table, and
 * a constraint kept in a meeting note apart from the memory about its subject.
 * Nothing here is real: the names, the firm and the facts are made up.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import type { ModuleCtx } from '../../../core/ctx.js'
import onUserPrompt from '../server/on-user-prompt.js'
import { RECALL_LOG } from '../server/recallLog.js'
import { MemoryStore, hashContent } from '../server/store.js'
import type { Memory, Shape } from '../server/types.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const DAY = 24 * 60 * 60 * 1000

export const FILLER = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `Note ${i + 1} on ${topic}: background, dates and logistics that the summary above does not need.`).join('\n')

const ROSTER = `Acme announced its new leadership team at the all-hands.

| Role | Name |
| --- | --- |
| CEO | Sam Rivera |
| CTO | Lee Okafor |
| CMO | Dana Quill |
| CFO | Sam Ortiz |

${FILLER('the announcement', 22)}`

const CALL = `Call with Sam on the Acme budget.

Agreed: the budget deck goes to Sam by Friday.
The pricing calculator is under embargo. Don't share it with Sam yet.

${FILLER('the call', 22)}`

export const fixture = () => {
  const db = new Database(':memory:')
  db.exec(schema)
  const store = new MemoryStore(db)
  const now = Date.now()
  const add = (name: string, content: string, over: Partial<Memory> = {}) =>
    store.upsert({
      id: `${name}-id`,
      source: `/mem/${name}.md`,
      name,
      description: '',
      content,
      shape: 'reference' as Shape,
      authorship: 'authored',
      scope: 'user',
      pinned: false,
      protected: false,
      machine: 'node-a',
      authoredAt: now - 2 * DAY,
      ingestedAt: now - 2 * DAY,
      outcome: '',
      outcomeText: '',
      contentHash: hashContent(name, '', content),
      ...over,
    } as never)
  add('acme-leadership-announced', ROSTER, { description: 'Acme leadership team announced at the all-hands' })
  add('acme-call-outcome', CALL, { description: 'Outcome of the budget call with Sam' })
  add('idea-acme-pricing-calculator', 'A pricing calculator for Acme that quotes orders from live stock levels. Build a demo for the deck.', { description: 'Pricing calculator idea for Acme' })
  add('acme-site-publish', 'The Acme site deck pages publish through the static host; side panels rebuild on push.', { description: 'How the Acme site publishes', authoredAt: now - DAY })
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engage-'))
  const ctx = { name: 'memory', dir: '', db, dataDir, log: () => {}, capabilities: { get: () => undefined } } as unknown as ModuleCtx
  return { db, store, ctx, dataDir, add }
}

export const prompt = (ctx: ModuleCtx, text: string, session = 's1') =>
  (onUserPrompt({ prompt: text, session_id: session }, ctx) as { additionalContext?: string } | undefined)?.additionalContext ?? ''

export const logRows = (dataDir: string) =>
  fs.readFileSync(path.join(dataDir, RECALL_LOG), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))

