import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { isolatedEnv } from '../../../test/isolatedEnv.js'
import { captureFile } from '../server/context/capture.js'
import { contextWindows, heatNow, HEAT_HALF_LIFE_MS, renderWindows, usedIn, wantsDepth } from '../server/context/depth.js'
import { ContextStore } from '../server/context/store.js'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const dirs: string[] = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-depth-'))
  dirs.push(d)
  return d
}
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const t = (s: number) => new Date(Date.UTC(2026, 9, 3, 10, 0, s)).toISOString()
const user = (uuid: string, s: number, text: string) => JSON.stringify({ type: 'user', uuid, timestamp: t(s), message: { content: text }, origin: { kind: 'human' } })
const said = (uuid: string, s: number, text: string) => JSON.stringify({ type: 'assistant', uuid, timestamp: t(s), message: { id: `m-${uuid}`, content: [{ type: 'text', text }] } })
const transcript = (file: string, mem: string) =>
  fs.writeFileSync(
    file,
    [
      user('u1', 1, 'Unrelated warm-up about the build cache.'),
      user('u2', 2, 'Should the job queue be RabbitMQ?'),
      said('a2', 3, 'No: ordering per key matters more than fan-out here, so the append-only log fits better than RabbitMQ.'),
      user('u3', 4, 'Agreed, go with the log.'),
      JSON.stringify({ type: 'assistant', uuid: 'w1', timestamp: t(5), message: { id: 'mw', content: [{ type: 'tool_use', id: 'tw', name: 'Write', input: { file_path: path.join(mem, 'queue-choice.md') } }] } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', parentUuid: null }),
      user('u4', 6, 'A later topic: the RabbitMQ admin page is down again.'),
    ].map((l) => `${l}\n`).join(''),
  )

test('depth is for why and design questions, not for plain asks', () => {
  for (const q of ['why did we pick the log?', 'what were the alternatives to RabbitMQ', 'remind me what we decided on queues']) assert.ok(wantsDepth(q), q)
  for (const q of ['run the tests', 'show the queue config', 'deploy it']) assert.ok(!wantsDepth(q), q)
})

test("windows come from the memory's anchor first, then keyword hits; they stop at a compaction and fit the budget", () => {
  const root = tmp()
  const mem = path.join(root, 'memory')
  fs.mkdirSync(mem)
  const store = new ContextStore(path.join(root, 'c.sqlite'))
  const file = path.join(root, 's.jsonl')
  transcript(file, mem)
  captureFile(store, { path: file, session: 's' }, 'node-a', { memoryDirs: [mem] })

  const ws = contextWindows(store, 'why rabbitmq', [{ name: 'queue-choice', source: path.join(mem, 'queue-choice.md') }])
  assert.match(ws[0]!.why, /produced memory queue-choice/)
  assert.ok(ws[0]!.blocks.some((b) => b.text.includes('append-only log')))
  assert.ok(ws.every((w) => !(w.blocks.some((b) => b.text.includes('admin page')) && w.blocks.some((b) => b.text.includes('go with the log')))), 'no window spans the compaction')

  const tiny = renderWindows(ws, 300)
  assert.ok(Buffer.byteLength(tiny.text) <= 300 || tiny.shown.length === 0)
  store.close()
})

test('used means cited by #id or eight words repeated; heat halves every 60 days and grows by grade', () => {
  const block = { id: 42, text: 'ordering per key matters more than fan-out here, so the append-only log fits better' }
  assert.ok(usedIn('Per #42 we chose the log.', block))
  assert.ok(usedIn('As noted, ordering per key matters more than fan-out here, so we went with it.', block))
  assert.ok(!usedIn('We use a log.', block))
  assert.equal(heatNow(1, 0, HEAT_HALF_LIFE_MS), 0.5)

  const root = tmp()
  const store = new ContextStore(path.join(root, 'c.sqlite'))
  store.touchHeat(['7'], 'block', 'related', 0)
  store.touchHeat(['7'], 'block', 'used', HEAT_HALF_LIFE_MS)
  assert.equal(store.heat('7', 'block', HEAT_HALF_LIFE_MS), 0.15 + 1)
  store.close()
})

test('end to end: a why prompt gets the dialogue behind the answer, and a reply citing it grades it used', () => {
  const { env, root } = isolatedEnv({ CKN_MODULES_DIR: path.join(REPO, 'modules'), CLAUDE_CODE_ENTRYPOINT: 'cli' })
  dirs.push(root)
  const mem = env.CKN_MEMORY_DIRS!
  const file = path.join(root, 'live.jsonl')
  transcript(file, mem)
  fs.writeFileSync(path.join(mem, 'queue-choice.md'), '---\nname: queue-choice\ndescription: The job queue is the append-only log, not RabbitMQ.\ntype: decision\n---\n\nUse the log for the job queue.\n')
  const hook = (event: string, payload: object) =>
    spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-hook.ts'), event], { input: JSON.stringify({ hook_event_name: event, ...payload }), env, encoding: 'utf-8' })
  hook('Stop', { session_id: 'live', transcript_path: file })
  hook('SessionStart', { session_id: 'live', source: 'startup', cwd: root })

  const out = hook('UserPromptSubmit', { session_id: 'live', prompt: 'why did we choose the log over RabbitMQ for the queue?' }).stdout
  assert.match(out, /earlier dialogue on this/)
  assert.match(out, /ordering per key matters more/)
  const id = Number(out.match(/#(\d+) assistant: No: ordering/)![1])

  hook('Stop', { session_id: 'live', transcript_path: file, last_assistant_message: `We chose the log (#${id}): ordering per key mattered more.` })
  const store = new ContextStore(path.join(env.CKN_STATE_DIR!, 'data', 'memory', 'context.sqlite'))
  assert.ok(store.heat(String(id), 'block') > 1, 'cited: used')
  const pull = store.db.prepare('SELECT quality, query FROM pulls ORDER BY id DESC').get() as { quality: string; query: string }
  assert.equal(pull.quality, 'used')
  assert.match(pull.query, /why did we choose the log/)
  store.close()

  assert.doesNotMatch(hook('UserPromptSubmit', { session_id: 'live', prompt: 'show me the queue config file please' }).stdout, /earlier dialogue/, 'no depth for a plain ask')
})
