/**
 * Replays recall.jsonl's constraint rows through the relevance gate, on the
 * machine that holds the transcripts: prompts and written text are read here
 * and never printed. The output is counts and memory slugs.
 *
 *   tsx modules/memory/calibrate/constraint-gate-replay.ts --db <COPY of cortex.sqlite> \
 *       --log <recall.jsonl> [--projects ~/.claude/projects]
 *
 * Run it on a backup-API copy of the store: the subject tables are rebuilt in it.
 *
 * For each row that carried constraints, the text it was matched on is found
 * again (prompt: the last user message at or before the row; write: the last
 * tool call at or before it), and every constraint the row logged is checked
 * against the gate. "Kept" is a logged constraint that still passes; the
 * prompt-time cap (2) then applies.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import Database from 'better-sqlite3'

import { applicableConstraints, scopeOfCwd, type Privacy } from '../server/constraints.js'
import { userText } from '../server/on-user-prompt.js'
import { outgoing } from '../server/on-pre-tool-constraints.js'
import { MemoryStore } from '../server/store.js'
import { indexSubjects } from '../server/subjects.js'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1]! : fallback
}
const dbPath = arg('--db') ?? (console.error('--db <copy of cortex.sqlite> is required'), process.exit(2))
const logPath = arg('--log') ?? (console.error('--log <recall.jsonl> is required'), process.exit(2))
const projects = arg('--projects', path.join(os.homedir(), '.claude', 'projects'))!

type Row = { at: number; session?: string; event: string; shown: string[]; constraints: string[] }
type Said = { at: number; cwd?: string; prompt?: string; tool?: { tool_name: string; tool_input: Record<string, unknown> } }

const transcriptOf = (session: string): string | undefined => {
  for (const dir of fs.readdirSync(projects)) {
    const f = path.join(projects, dir, `${session}.jsonl`)
    if (fs.existsSync(f)) return f
  }
  return undefined
}

/** User prompts and tool calls with their times: all a row needs, never the whole file in memory. */
const readSaid = async (file: string): Promise<Said[]> => {
  const out: Said[] = []
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.includes('"timestamp"')) continue
    let r: { type?: string; timestamp?: string; cwd?: string; message?: { content?: unknown } }
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(r.timestamp ?? '')
    if (!at) continue
    const content = r.message?.content
    if (r.type === 'user') {
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : ''
      const q = userText(text)
      if (q) out.push({ at, cwd: r.cwd, prompt: q })
    } else if (r.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) if (c?.type === 'tool_use') out.push({ at, cwd: r.cwd, tool: { tool_name: c.name, tool_input: c.input ?? {} } })
    }
  }
  return out
}

const main = async () => {
  const db = new Database(dbPath)
  const store = new MemoryStore(db)
  indexSubjects(store)
  const people = store.peopleTokens()
  const privacy: Privacy = { privatePlaces: [], compensationOn: ['*'] } // replay what was shown; privacy is not under test
  const rows = fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row)
    .filter((r) => r.constraints?.length && r.session && (r.event === 'prompt' || r.event === 'write'))

  const said = new Map<string, Said[]>()
  const t = {
    prompt: { rows: 0, logged: 0, gated: 0, capped: 0, unmatched: 0, loggedOff: 0, keptOff: 0 },
    write: { rows: 0, logged: 0, gated: 0, capped: 0, unmatched: 0, loggedOff: 0, keptOff: 0 },
  }
  const dropped = new Map<string, number>()
  const kept = new Map<string, number>()
  const slug = (id: string): string => id.replace(/-[0-9a-f]{12}(#\d+)?$/, '')

  for (const r of rows) {
    if (!said.has(r.session!)) {
      const f = transcriptOf(r.session!)
      said.set(r.session!, f ? await readSaid(f) : [])
    }
    // A tool call lands in the transcript just after its PreToolUse fires, and one message may hold
    // several calls: take the nearest one that has text going out.
    const before = said
      .get(r.session!)!
      .filter((s) => s.at <= r.at + 5000 && (r.event === 'prompt' ? s.prompt : s.tool && outgoing(s.tool as never)))
    const src = before.at(-1)
    const tally = t[r.event as 'prompt' | 'write']
    tally.rows++
    tally.logged += r.constraints.length
    const text = src ? (r.event === 'prompt' ? src.prompt! : outgoing(src.tool as never)) : null
    if (!text) {
      tally.unmatched += r.constraints.length
      continue
    }
    const topics =
      r.event === 'prompt'
        ? r.shown.map((id) => store.get(id)).filter((m) => !!m).map((m) => `${m!.name.replace(/[-_]+/g, ' ')}\n${m!.description}`)
        : []
    const pass = new Set(
      applicableConstraints(store, {
        texts: [text],
        topics,
        machine: ['*'],
        privacy,
        max: Number.MAX_SAFE_INTEGER,
        gate: { people, ...(src?.cwd ? { scope: scopeOfCwd(src.cwd) } : {}) },
        textPhrases: r.event === 'prompt',
      }).map((c) => `${c.memoryId}#${c.ord}`),
    )
    // Off-topic proxy, computed here and printed as counts: a kept line whose memory slug shares no word with the text.
    const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3))
    const onTopic = (c: string) => slug(c).toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 3 && words.has(w))
    const survive = r.constraints.filter((c) => pass.has(c))
    tally.gated += survive.length
    tally.loggedOff += r.constraints.filter((c) => !onTopic(c)).length
    tally.keptOff += survive.filter((c) => !onTopic(c)).length
    tally.capped += Math.min(survive.length, r.event === 'prompt' ? 2 : 5)
    for (const c of r.constraints) (pass.has(c) ? kept : dropped).set(slug(c), ((pass.has(c) ? kept : dropped).get(slug(c)) ?? 0) + 1)
  }

  console.log('constraint gate replay (counts and slugs only)')
  for (const [ev, x] of Object.entries(t))
    console.log(
      `  ${ev}: ${x.rows} rows, ${x.logged} logged lines -> ${x.gated} pass the gate -> ${x.capped} after the cap; ${x.unmatched} unmatched\n` +
        `      sharing no slug word with the text: ${x.loggedOff} of the logged -> ${x.keptOff} of those kept`,
    )
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s, n]) => `    ${n} ${s}`).join('\n')
  console.log(`  most dropped:\n${top(dropped)}`)
  console.log(`  most kept:\n${top(kept)}`)
  db.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
