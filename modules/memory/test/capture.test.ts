import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { captureAll, captureFile, captureStatus, cleanupHorizonDays, transcriptFiles } from '../server/context/capture.js'
import { ContextStore } from '../server/context/store.js'
import { newState, parseLine } from '../server/context/transcript.js'

const dirs: string[] = []
const tmpdir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-capture-'))
  dirs.push(d)
  return d
}
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

// Synthetic transcript lines, shaped like Claude Code's (field names only; nothing real).
let n = 0
const ts = () => new Date(Date.UTC(2026, 9, 1, 12, 0, n++)).toISOString()
const human = (text: string, extra: object = {}) => JSON.stringify({ type: 'user', uuid: `u${n}`, sessionId: 's1', timestamp: ts(), message: { role: 'user', content: text }, origin: { kind: 'human' }, ...extra })
const plain = (text: string, extra: object = {}) => JSON.stringify({ type: 'user', uuid: `p${n}`, sessionId: 's1', timestamp: ts(), message: { role: 'user', content: text }, ...extra })
const said = (id: string, text: string) => JSON.stringify({ type: 'assistant', uuid: `a${n}`, sessionId: 's1', timestamp: ts(), message: { id, content: [{ type: 'text', text }] } })
const thought = (id: string) => JSON.stringify({ type: 'assistant', uuid: `t${n}`, timestamp: ts(), message: { id, content: [{ type: 'thinking', thinking: 'private reasoning' }] } })
const toolUse = (id: string, toolId: string, name: string, input: object) =>
  JSON.stringify({ type: 'assistant', uuid: `tu${n}`, timestamp: ts(), message: { id, content: [{ type: 'tool_use', id: toolId, name, input }] } })
const toolResult = (toolId: string, isError: boolean, content: string) =>
  JSON.stringify({ type: 'user', uuid: `tr${n}`, timestamp: ts(), message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isError, content }] } })

const parseAll = (lines: string[]) => {
  const state = newState()
  return lines.flatMap((l) => parseLine(l, state).parts)
}

test('only what was said is kept: human and assistant text, never thinking, tool output or injected lines', () => {
  const parts = parseAll([
    human('Why did we pick the queue?'),
    plain('typed before origin existed'),
    plain('a peer message', { origin: { kind: 'peer' }, isMeta: true }),
    plain('a background task finished', { origin: { kind: 'task-notification' } }),
    plain('summary of earlier context', { isCompactSummary: true }),
    plain('<local-command-stdout>output</local-command-stdout>'),
    plain('<system-reminder>injected</system-reminder>'),
    JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: 'recall text' } }),
    thought('m1'),
    said('m1', 'Because it keeps order per key.'),
    toolUse('m1', 'tool-1', 'Bash', { command: 'ls /nowhere' }),
    toolResult('tool-1', false, 'a long successful listing'),
    'not json at all',
  ])
  assert.deepEqual(
    parts.map((p) => [p.speaker, p.text]),
    [
      ['user', 'Why did we pick the queue?'],
      ['user', 'typed before origin existed'],
      ['assistant', 'Because it keeps order per key.'],
    ],
  )
})

test('slash and shell commands keep what the person typed, not their output', () => {
  const parts = parseAll([
    plain('<command-message>rename</command-message><command-name>/rename</command-name><command-args>alpha-dev</command-args>'),
    plain('<bash-input>git status</bash-input>'),
    plain('<bash-stdout>clean</bash-stdout>'),
  ])
  assert.deepEqual(parts.map((p) => p.text), ['/rename alpha-dev', '! git status'])
})

test('a tool failure becomes a short note naming the tool and what it ran', () => {
  const parts = parseAll([toolUse('m2', 'tool-2', 'Bash', { command: 'npm run missing-script' }), toolResult('tool-2', true, 'npm ERR! missing script\nmore detail')])
  assert.equal(parts.length, 1)
  assert.equal(parts[0]!.speaker, 'tool-note')
  assert.equal(parts[0]!.text, 'Bash npm run missing-script failed: npm ERR! missing script')
})

test('the first block after a compaction is marked as such', () => {
  const parts = parseAll([said('m3', 'before'), JSON.stringify({ type: 'system', subtype: 'compact_boundary', parentUuid: null }), said('m4', 'after')])
  assert.deepEqual(parts.map((p) => !!p.boundary), [false, true])
})

const writeLines = (file: string, lines: string[], append = false) => (append ? fs.appendFileSync : fs.writeFileSync)(file, lines.map((l) => `${l}\n`).join(''))

test('one assistant message over several lines is one block; reading twice adds nothing', () => {
  const root = tmpdir()
  const store = new ContextStore(path.join(root, 'context.sqlite'))
  const file = path.join(root, 's1.jsonl')
  writeLines(file, [human('Plan the cache?'), said('m5', 'First part.'), thought('m5'), said('m5', 'Second part.')])
  assert.equal(captureFile(store, { path: file, session: 's1' }, 'node-a').added, 3)
  assert.equal(captureFile(store, { path: file, session: 's1' }, 'node-a').added, 0)
  const rows = store.db.prepare('SELECT speaker, text FROM blocks ORDER BY seq').all() as { speaker: string; text: string }[]
  assert.deepEqual(rows, [
    { speaker: 'user', text: 'Plan the cache?' },
    { speaker: 'assistant', text: 'First part.\n\nSecond part.' },
  ])
  store.close()
})

test('a line still being written is not read until it ends', () => {
  const root = tmpdir()
  const store = new ContextStore(path.join(root, 'context.sqlite'))
  const file = path.join(root, 's2.jsonl')
  const line = human('half written then finished')
  fs.writeFileSync(file, `${human('first')}\n${line.slice(0, 20)}`)
  const r1 = captureFile(store, { path: file, session: 's2' }, 'node-a')
  assert.equal(r1.added, 1)
  assert.equal(r1.done, false, 'the cursor stops before the partial line')
  fs.appendFileSync(file, `${line.slice(20)}\n`)
  const r2 = captureFile(store, { path: file, session: 's2' }, 'node-a')
  assert.equal(r2.added, 1)
  assert.equal(r2.done, true)
  store.close()
})

test('a rewritten transcript is read again from the start, without duplicates', () => {
  const root = tmpdir()
  const store = new ContextStore(path.join(root, 'context.sqlite'))
  const file = path.join(root, 's3.jsonl')
  writeLines(file, [human('one'), human('two')])
  captureFile(store, { path: file, session: 's3' }, 'node-a')
  writeLines(file, [human('replaced one'), human('replaced two'), human('three')])
  const r = captureFile(store, { path: file, session: 's3' }, 'node-a')
  assert.equal(r.restarted, true)
  assert.equal(store.counts().blocks, 5)
  store.close()
})

test('secrets in dialogue are redacted before they are stored', () => {
  const root = tmpdir()
  const store = new ContextStore(path.join(root, 'context.sqlite'))
  const file = path.join(root, 's4.jsonl')
  writeLines(file, [human('the key is AKIAABCDEFGHIJKLMNOP\nand the rest is fine')])
  captureFile(store, { path: file, session: 's4' }, 'node-a')
  const text = (store.db.prepare('SELECT text FROM blocks').get() as { text: string }).text
  assert.ok(!text.includes('AKIA'), 'the credential never reaches the store')
  assert.match(text, /^\[redacted: provider-prefix\]\nand the rest is fine$/)
  assert.equal(store.cursor(file)!.redactions, 1)
  store.close()
})

test('a headless run is recorded as skipped, not captured', () => {
  const root = tmpdir()
  const store = new ContextStore(path.join(root, 'context.sqlite'))
  const file = path.join(root, 's5.jsonl')
  writeLines(file, [JSON.stringify({ type: 'queue-operation', sessionId: 's5' }), human('judge this', { entrypoint: 'sdk-cli' })])
  const r = captureFile(store, { path: file, session: 's5' }, 'node-a')
  assert.match(r.skipped ?? '', /headless/)
  assert.deepEqual(store.counts(), { sessions: 0, blocks: 0, files: 1 }, 'no session row is left from the lines before the entrypoint showed')
  store.close()
})

test('catch-up finds every transcript, subagents included, and a deadline only defers work', () => {
  const root = tmpdir()
  const projects = path.join(root, 'projects')
  fs.mkdirSync(path.join(projects, 'proj', 'sess-a', 'subagents'), { recursive: true })
  writeLines(path.join(projects, 'proj', 'sess-a.jsonl'), [human('main session')])
  writeLines(path.join(projects, 'proj', 'sess-a', 'subagents', 'agent-x.jsonl'), [said('m6', 'subagent finding')])
  assert.deepEqual(
    transcriptFiles(projects).map((f) => [f.session, f.parent ?? null]).sort(),
    [['sess-a', null], ['sess-a/agent-x', 'sess-a']],
  )
  const store = new ContextStore(path.join(root, 'context.sqlite'))
  assert.equal(captureAll(store, projects, 'node-a', { deadline: Date.now() - 1 }).results.length, 0)
  const r = captureAll(store, projects, 'node-a')
  assert.equal(r.results.length, 2)
  assert.equal(captureAll(store, projects, 'node-a').pending, 0, 'nothing left once captured')
  const parent = store.db.prepare("SELECT parent FROM sessions WHERE session = 'sess-a/agent-x'").get() as { parent: string }
  assert.equal(parent.parent, 'sess-a')
  store.close()
})

test('status warns about a transcript cleanup could delete before it is captured', () => {
  const root = tmpdir()
  const projects = path.join(root, 'projects')
  fs.mkdirSync(path.join(projects, 'proj'), { recursive: true })
  const old = path.join(projects, 'proj', 'old.jsonl')
  const fresh = path.join(projects, 'proj', 'fresh.jsonl')
  writeLines(old, [human('old conversation')])
  writeLines(fresh, [human('new conversation')])
  const days = (d: number) => new Date(Date.now() - d * 86_400_000)
  fs.utimesSync(old, days(26), days(26))
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 30 }))
  assert.equal(cleanupHorizonDays(root), 30)
  const store = new ContextStore(path.join(root, 'context.sqlite'))
  let s = captureStatus(store, projects, 30)
  assert.equal(s.incomplete.length, 2)
  assert.deepEqual(s.atRisk.map((a) => path.basename(a.path)), ['old.jsonl'])
  captureAll(store, projects, 'node-a')
  s = captureStatus(store, projects, 30)
  assert.equal(s.complete, 2)
  assert.equal(s.atRisk.length, 0)
  store.close()
})

test('keyword search finds a block, and its window stays inside its session', () => {
  const root = tmpdir()
  const store = new ContextStore(path.join(root, 'context.sqlite'))
  const file = path.join(root, 's6.jsonl')
  writeLines(file, [human('Should the queue be RabbitMQ?'), said('m7', 'No: ordering per key matters more, so a log fits.'), human('Agreed, use the log.')])
  captureFile(store, { path: file, session: 's6' }, 'node-a')
  const other = path.join(root, 's7.jsonl')
  writeLines(other, [human('unrelated session')])
  captureFile(store, { path: other, session: 's7' }, 'node-a')
  const hit = store.search('rabbitmq queue')[0]!
  assert.match(hit.text, /RabbitMQ/)
  assert.deepEqual(store.window(hit.id, 3).map((b) => b.session), ['s6', 's6', 's6'])
  assert.deepEqual(store.search('"; DROP TABLE blocks; --'), [], 'a query is words, never FTS syntax')
  store.close()
})

// ── dialogue feeds (core/dialogue.ts): Telegram and the bus ──────────────────

import { appendDialogue, type DialogueRecord } from '../../../core/dialogue.js'
import { feedFiles } from '../server/context/feed.js'

const rec = (over: Partial<DialogueRecord>): DialogueRecord => ({
  v: 1, id: 'r1', at: Date.UTC(2026, 9, 1, 12, 0, 30), source: 'telegram',
  from: { kind: 'operator', name: 'alex' }, to: { kind: 'member', name: 'game-dev-1' },
  text: 'Ship the boss fight first.', member: 'game-dev-1', ...over,
})

test('a module declaring dialogue has its feed captured: operator and session speak in one channel session', () => {
  const root = tmpdir()
  const modules = path.join(root, 'modules')
  const data = path.join(root, 'data')
  fs.mkdirSync(path.join(modules, 'chat'), { recursive: true })
  fs.writeFileSync(path.join(modules, 'chat', 'module.json'), JSON.stringify({ name: 'chat', dialogue: true }))
  fs.mkdirSync(path.join(modules, 'quiet'), { recursive: true })
  fs.writeFileSync(path.join(modules, 'quiet', 'module.json'), JSON.stringify({ name: 'quiet' }))
  appendDialogue('chat', 'session', [rec({}), rec({ id: 'r2', at: Date.UTC(2026, 9, 1, 12, 0, 40), from: { kind: 'member', name: 'game-dev-1' }, to: { kind: 'operator', name: 'alex' }, text: 'On it; the key AKIAABCDEFGHIJKLMNOP is not needed.', replyTo: 'r1' })], data)
  appendDialogue('quiet', 'x', [rec({ id: 'q1' })], data)
  const feeds = feedFiles(modules, data)
  assert.deepEqual(feeds.map((f) => path.basename(path.dirname(path.dirname(f.path)))), ['chat'], 'only modules that declare a feed')

  const store = new ContextStore(path.join(root, 'context.sqlite'))
  captureAll(store, path.join(root, 'no-projects'), 'node-a', { feeds })
  captureAll(store, path.join(root, 'no-projects'), 'node-a', { feeds })
  const rows = store.db.prepare('SELECT session, speaker, party, source, text FROM blocks ORDER BY at').all() as Record<string, string>[]
  assert.equal(rows.length, 2, 'a second pass adds nothing')
  assert.deepEqual(rows.map((r) => [r.session, r.speaker, r.party, r.source]), [
    ['telegram:game-dev-1', 'operator', 'alex', 'telegram'],
    ['telegram:game-dev-1', 'member', 'game-dev-1', 'telegram'],
  ])
  assert.ok(!rows[1]!.text!.includes('AKIA'), 'feeds are redacted like transcripts')
  store.close()
})

test("a window over a transcript block brings in the member's Telegram exchange from the same span", () => {
  const root = tmpdir()
  const store = new ContextStore(path.join(root, 'context.sqlite'))
  const file = path.join(root, 'sess.jsonl')
  const t = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString()
  writeLines(file, [
    JSON.stringify({ type: 'custom-title', customTitle: 'game-dev-1', sessionId: 'sess' }),
    JSON.stringify({ type: 'user', uuid: 'w1', timestamp: t(10), message: { content: 'Plan the level order.' }, origin: { kind: 'human' } }),
    JSON.stringify({ type: 'assistant', uuid: 'w2', timestamp: t(50), message: { id: 'mw', content: [{ type: 'text', text: 'Boss fight first, as asked on Telegram.' }] } }),
  ])
  captureFile(store, { path: file, session: 'sess' }, 'node-a')
  const feedDir = path.join(root, 'data')
  appendDialogue('chat', 'session', [rec({ at: Date.UTC(2026, 9, 1, 12, 0, 30) })], feedDir)
  captureAll(store, path.join(root, 'none'), 'node-a', { feeds: [{ path: path.join(feedDir, 'chat', 'dialogue', 'session.ndjson'), session: 'feed:chat', kind: 'feed' }] })
  const hit = store.search('boss fight first')[0]!
  const w = store.windowAcross(hit.id, 3)
  assert.deepEqual(w.map((b) => b.party ?? b.speaker), ['user', 'alex', 'assistant'], 'interleaved by time')
  store.close()
})

// ── anchors: a memory finds the dialogue that produced it ─────────────────────

import { backfillAnchors } from '../server/context/capture.js'

const writeLine = (file: string, at: string) =>
  JSON.stringify({ type: 'assistant', uuid: `w${n++}`, timestamp: at, message: { id: `mw${n}`, content: [{ type: 'tool_use', id: `tw${n}`, name: 'Write', input: { file_path: file, content: '...' } }] } })
const heredocLine = (file: string, at: string) =>
  JSON.stringify({ type: 'assistant', uuid: `h${n++}`, timestamp: at, message: { id: `mh${n}`, content: [{ type: 'tool_use', id: `th${n}`, name: 'Bash', input: { command: `cat > ${file} <<'EOF'` } }] } })

const anchorTranscript = (root: string) => {
  const mem = path.join(root, 'memory')
  fs.mkdirSync(mem, { recursive: true })
  const projects = path.join(root, 'projects', 'p')
  fs.mkdirSync(projects, { recursive: true })
  const file = path.join(projects, 'sess.jsonl')
  const t = (s: number) => new Date(Date.UTC(2026, 9, 2, 9, 0, s)).toISOString()
  writeLines(file, [
    JSON.stringify({ type: 'user', uuid: 'q1', timestamp: t(1), sessionId: 'sess', message: { content: 'Should the queue be RabbitMQ?' }, origin: { kind: 'human' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: t(2), message: { id: 'ma1', content: [{ type: 'text', text: 'No: ordering per key matters more, so use the log.' }] } }),
    JSON.stringify({ type: 'user', uuid: 'q2', timestamp: t(3), message: { content: 'Agreed. Remember that.' }, origin: { kind: 'human' } }),
    writeLine(path.join(mem, 'queue-choice.md'), t(4)),
    writeLine(path.join(root, 'notes', 'scratch.md'), t(5)),
    heredocLine(path.join(mem, 'queue-detail.md'), t(6)),
  ])
  return { mem, projects: path.join(root, 'projects'), file }
}

test("a memory written in a session is anchored to the dialogue before the write; other files are not", () => {
  const root = tmpdir()
  const { mem, file } = anchorTranscript(root)
  const store = new ContextStore(path.join(root, 'context.sqlite'))
  captureFile(store, { path: file, session: 'sess' }, 'node-a', { memoryDirs: [mem] })
  const [a] = store.anchorsFor(path.join(mem, 'queue-choice.md'))
  assert.ok(a, 'anchored')
  assert.deepEqual(store.anchoredBlocks(a!).map((b) => b.text), ['Should the queue be RabbitMQ?', 'No: ordering per key matters more, so use the log.', 'Agreed. Remember that.'])
  assert.equal(store.anchorsFor(path.join(mem, 'queue-detail.md')).length, 1, 'a shell heredoc into a memory dir counts too')
  assert.equal(store.anchorsFor(path.join(root, 'notes', 'scratch.md')).length, 0, 'not a memory file')
  store.close()
})

test('anchors backfill from transcripts captured before anchoring existed, and a second run adds nothing', () => {
  const root = tmpdir()
  const { mem, projects } = anchorTranscript(root)
  const store = new ContextStore(path.join(root, 'context.sqlite'))
  captureAll(store, projects, 'node-a') // no memory dirs: as capture ran before step 2
  assert.equal(store.anchorsFor(path.join(mem, 'queue-choice.md')).length, 0)
  assert.deepEqual(backfillAnchors(store, projects, 'node-a', [mem]), { files: 1, anchors: 2 })
  assert.deepEqual(backfillAnchors(store, projects, 'node-a', [mem]), { files: 1, anchors: 0 })
  assert.equal(store.anchorsFor(path.join(mem, 'queue-choice.md'))[0]!.how, 'backfill')
  store.close()
})
