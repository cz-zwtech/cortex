/**
 * Adaptive recall (private mind design 4.6, 4.7): prompt-time recall stays
 * fast with memory summaries, and goes deeper only when the prompt asks for
 * it: a why, a design question, alternatives, an earlier decision. Then
 * windows of the dialogue that produced the answer are added, within a fixed
 * budget, and the running session judges which apply (no model call here).
 *
 * Heat is graded: a window surfaced earns `related`; one the answer then cites
 * earns `used`. Untouched heat halves every 60 days. Every pull is logged with
 * its reason and how it was used: the record archive promotion scores later.
 */
import fs from 'node:fs'
import path from 'node:path'

import type { BlockRow, ContextStore } from './store.js'

export const DEPTH_BUDGET_BYTES = 4_096
export const WINDOW_N = 3
export const MAX_WINDOWS = 8
export const HEAT_HALF_LIFE_MS = 60 * 86_400_000
export const HEAT = { related: 0.3, used: 1 } as const

const TRIGGERS = [
  /\bwhy\b/i,
  /\bhow come\b/i,
  /\b(reason|reasons|reasoning|rationale)\b/i,
  /\b(decide|decided|decision|chose|choose|chosen)\b/i,
  /\b(design|architecture|trade-?offs?|alternatives?)\b/i,
  /\bwhat did (we|you|i) (say|decide|agree|conclude)\b/i,
  /\b(remind me|last time|earlier|back when|previously)\b/i,
]

/** Whether a prompt asks for the reasoning behind something, not just the fact. */
export const wantsDepth = (prompt: string): boolean => TRIGGERS.some((t) => t.test(prompt))

export type Window = { machine: string; session: string; from: number; to: number; why: string; blocks: BlockRow[] }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A window stops at a compaction: what came before it belongs to another stretch. */
const trimAtBoundary = (blocks: BlockRow[], hitSeq: number): BlockRow[] => {
  let start = 0
  for (let i = 0; i < blocks.length; i++) if (blocks[i]!.boundary && blocks[i]!.seq <= hitSeq) start = i
  const end = blocks.findIndex((b, i) => i > start && b.boundary && b.seq > hitSeq)
  return blocks.slice(start, end < 0 ? undefined : end)
}

/**
 * The dialogue windows for a query: the anchors of the memories recall
 * returned first (the conversation that produced them), then keyword hits on
 * the dialogue itself, each widened by n blocks. Overlapping windows merge.
 */
export const contextWindows = (store: ContextStore, query: string, sources: { name: string; source: string }[], opts: { n?: number; max?: number } = {}): Window[] => {
  const n = opts.n ?? WINDOW_N
  const max = opts.max ?? MAX_WINDOWS
  const out: Window[] = []
  // Two windows merge when they touch, unless a compaction falls between them.
  const crossesBoundary = (machine: string, session: string, from: number, to: number) =>
    !!store.db.prepare('SELECT 1 FROM blocks WHERE machine = ? AND session = ? AND boundary = 1 AND seq > ? AND seq <= ?').get(machine, session, from, to)
  const add = (w: Window) => {
    const same = out.find(
      (o) =>
        o.machine === w.machine && o.session === w.session && w.from <= o.to + 1 && w.to >= o.from - 1 &&
        !crossesBoundary(w.machine, w.session, Math.min(o.from, w.from), Math.max(o.to, w.to)),
    )
    if (same) {
      same.from = Math.min(same.from, w.from)
      same.to = Math.max(same.to, w.to)
      return
    }
    if (out.length < max) out.push(w)
  }
  for (const s of sources) {
    const a = store.anchorsFor(s.source)[0]
    if (a) add({ machine: a.machine, session: a.session, from: a.seq_from, to: a.seq_to, why: `the dialogue that produced memory ${s.name}`, blocks: [] })
  }
  for (const hit of store.search(query, max * 2)) {
    if (out.length >= max && !out.some((o) => o.session === hit.session)) break
    const blocks = trimAtBoundary(store.window(hit.id, n), hit.seq)
    if (blocks.length) add({ machine: hit.machine, session: hit.session, from: blocks[0]!.seq, to: blocks.at(-1)!.seq, why: 'matches the question', blocks: [] })
  }
  for (const w of out) w.blocks = store.anchoredBlocks({ machine: w.machine, session: w.session, seq_from: w.from, seq_to: w.to })
  return out
}

/** Windows as context text, within the budget. Block ids let the answer cite them. */
export const renderWindows = (windows: Window[], budget = DEPTH_BUDGET_BYTES): { text: string; shown: Window[] } => {
  const head = '## Cortex — earlier dialogue on this (judge which applies; cite #ids you use)'
  let text = head
  const shown: Window[] = []
  for (const w of windows) {
    const when = w.blocks[0] ? new Date(w.blocks[0].at).toISOString().slice(0, 10) : ''
    let part = `\n\n- ${when}, session ${w.session.slice(0, 8)} (${w.why}):`
    for (const b of w.blocks) part += `\n  #${b.id} ${b.party ?? b.speaker}: ${clip(b.text.replace(/\s+/g, ' '), 360)}`
    if (Buffer.byteLength(text + part) > budget) {
      if (!shown.length) continue
      break
    }
    text += part
    shown.push(w)
  }
  return { text: shown.length ? text : '', shown }
}

/** Heat now: the stored score halved for every 60 days since it was last touched. */
export const heatNow = (score: number, lastAt: number, now = Date.now()): number => score * 0.5 ** ((now - lastAt) / HEAT_HALF_LIFE_MS)

/** What a session was shown this turn, so Stop can tell which windows the answer used. */
export type Surfaced = { at: number; query: string; blocks: { id: number; text: string }[]; memories: string[] }

const surfacedFile = (dataDir: string, session: string) => path.join(dataDir, 'surfaced', `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

export const rememberSurfaced = (dataDir: string, session: string, s: Surfaced): void => {
  try {
    fs.mkdirSync(path.join(dataDir, 'surfaced'), { recursive: true })
    fs.writeFileSync(surfacedFile(dataDir, session), JSON.stringify(s))
  } catch {
    /* heat is a refinement: losing it never costs a turn */
  }
}

export const takeSurfaced = (dataDir: string, session: string): Surfaced | undefined => {
  const f = surfacedFile(dataDir, session)
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf-8')) as Surfaced
    fs.rmSync(f, { force: true })
    return s
  } catch {
    return undefined
  }
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/**
 * Whether an answer used a block: it cites the block's #id, or repeats a run of
 * eight of its words. A conservative test on purpose: a false `used` would
 * promote the wrong stretch.
 */
export const usedIn = (reply: string, block: { id: number; text: string }): boolean => {
  if (new RegExp(`#${block.id}\\b`).test(reply)) return true
  const bw = words(block.text)
  if (bw.length < 8) return false
  const r = ` ${words(reply).join(' ')} `
  for (let i = 0; i + 8 <= bw.length; i++) if (r.includes(` ${bw.slice(i, i + 8).join(' ')} `)) return true
  return false
}
