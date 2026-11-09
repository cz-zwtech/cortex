/**
 * The engagement prompts replayed on the invented fixture, printing what was
 * injected and the recall log row for each.
 *   tsx modules/memory/test/replay-engagement.ts
 */
import { fixture, logRows, prompt } from './engagement-fixture.js'

const PROMPTS = [
  'on the marketing side at Acme, which c-suite exec owns it?',
  'add the next steps to the budget deck for Sam',
  'what is the pricing calculator idea again?',
]

const { ctx, dataDir } = fixture()
for (const p of PROMPTS) {
  const out = prompt(ctx, p)
  console.log(`\n=== prompt: ${p}\n--- injected:\n${out || '(nothing)'}`)
}
console.log('\n--- recall.jsonl:')
for (const r of logRows(dataDir)) console.log(JSON.stringify(r))
