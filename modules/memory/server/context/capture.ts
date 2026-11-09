/**
 * Capture: session transcripts into the context store, completely and before
 * Claude Code's cleanup can delete them (private mind design, section 4.2.1).
 *
 * Each transcript file has a cursor: the byte offset up to which every complete
 * line is captured, with a hash of the last captured line. A capture reads on
 * from the cursor, only ever whole lines, so a file that is still being written
 * is never read mid-line. A file that shrank or whose tail no longer matches
 * was rewritten, and is read again from the start (applying parts is
 * idempotent, so nothing doubles).
 *
 * A file counts as captured when its cursor is at its end. `captureStatus`
 * reports the files that are not, and warns about any that cleanup could
 * delete soon: transcripts become disposable only once the store has them.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { ContextStore, FileCursor } from './store.js'
import { parseFeedLine } from './feed.js'
import { newState, parseLine, type ParseState, type SessionMeta } from './transcript.js'

const DAY_MS = 86_400_000
/** How far before cleanup a file not yet captured raises a warning. */
export const WARN_BEFORE_DAYS = 7
const CHUNK = 1 << 20

/** A file capture reads: a session transcript, or a module's dialogue feed. */
export type TranscriptFile = { path: string; session: string; parent?: string; kind?: 'transcript' | 'feed' }

/** Every transcript under Claude Code's projects dir, subagent transcripts included. */
export const transcriptFiles = (projectsDir: string): TranscriptFile[] => {
  const out: TranscriptFile[] = []
  let projects: string[]
  try {
    projects = fs.readdirSync(projectsDir)
  } catch {
    return out
  }
  for (const proj of projects) {
    const dir = path.join(projectsDir, proj)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ path: path.join(dir, e.name), session: e.name.slice(0, -6) })
      if (e.isDirectory()) {
        const sub = path.join(dir, e.name, 'subagents')
        let agents: string[] = []
        try {
          agents = fs.readdirSync(sub).filter((f) => f.endsWith('.jsonl'))
        } catch {
          /* no subagents */
        }
        for (const a of agents) out.push({ path: path.join(sub, a), session: `${e.name}/${a.slice(0, -6)}`, parent: e.name })
      }
    }
  }
  return out
}

/** Claude Code deletes transcripts older than this many days (settings `cleanupPeriodDays`, default 30). */
export const cleanupHorizonDays = (claudeDir: string): number => {
  for (const f of ['settings.json', 'settings.local.json'].reverse()) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(claudeDir, f), 'utf-8')).cleanupPeriodDays
      if (typeof v === 'number' && v > 0) return v
    } catch {
      /* absent or unreadable */
    }
  }
  return 30
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

const readRange = (fd: number, start: number, len: number): Buffer => {
  const b = Buffer.alloc(len)
  const n = fs.readSync(fd, b, 0, len, start)
  return b.subarray(0, n)
}

/** A headless run (claude -p and the SDK) is automation, not a conversation. */
const isHeadless = (m: SessionMeta) => !!m.entrypoint && m.entrypoint.startsWith('sdk') && !m.sidechain

export type FileResult = { path: string; added: number; done: boolean; skipped?: string; restarted?: boolean }

/** Options for a capture pass. `memoryDirs`: a write into one of these anchors the memory it wrote. */
export type CaptureOptions = { deadline?: number; memoryDirs?: string[] }

const inMemoryDir = (file: string, dirs: string[] | undefined) => !!dirs?.length && dirs.some((d) => path.dirname(path.resolve(file)) === path.resolve(d))

export const captureFile = (store: ContextStore, f: TranscriptFile, machine: string, opts: CaptureOptions = {}): FileResult => {
  let st: fs.Stats
  try {
    st = fs.statSync(f.path)
  } catch {
    return { path: f.path, added: 0, done: true, skipped: 'gone' }
  }
  const prev = store.cursor(f.path)
  const c: FileCursor = prev ?? {
    path: f.path, machine, session: f.session, offset: 0, size: 0, tail_hash: null, tail_len: 0,
    lines: 0, parts: 0, redactions: 0, state: null, skipped: null, mtime: null, updated_at: null,
  }
  c.size = st.size
  c.mtime = Math.floor(st.mtimeMs)
  if (c.skipped) {
    c.updated_at = Date.now()
    store.saveCursor(c)
    return { path: f.path, added: 0, done: true, skipped: c.skipped }
  }

  const fd = fs.openSync(f.path, 'r')
  let added = 0
  let restarted = false
  try {
    // A file that shrank, or whose last captured line is not where it was, was rewritten.
    if (c.offset > st.size || (c.offset > 0 && c.tail_hash && sha(readRange(fd, c.offset - c.tail_len, c.tail_len)) !== c.tail_hash)) {
      Object.assign(c, { offset: 0, tail_hash: null, tail_len: 0, lines: 0, state: null })
      restarted = true
    }
    const state: ParseState = c.state ? JSON.parse(c.state) : newState()
    let meta: SessionMeta = {}
    const record = store.db.transaction((lines: Buffer[]) => {
      for (const raw of lines) {
        if (f.kind === 'feed') {
          const r = parseFeedLine(raw.toString('utf-8'))
          if (!r) continue
          const applied = store.apply(machine, r.session, r.part, r.source)
          if (applied.added) {
            added++
            c.parts++
            c.redactions += applied.redacted
            store.session(machine, r.session, { title: r.member, entrypoint: r.source }, r.part.at)
          }
          continue
        }
        const parsed = parseLine(raw.toString('utf-8'), state)
        if (parsed.meta) meta = { ...meta, ...parsed.meta }
        if (isHeadless(meta)) {
          c.skipped = `headless run (entrypoint ${meta.entrypoint})`
          store.dropSession(machine, f.session)
          return
        }
        for (const p of parsed.parts) {
          const r = store.apply(machine, f.session, p)
          if (r.added) {
            added++
            c.parts++
            c.redactions += r.redacted
          }
        }
        if (parsed.meta || parsed.parts.length) {
          store.session(machine, f.session, { ...meta, parent: f.parent }, parsed.parts.at(-1)?.at)
        }
        for (const w of parsed.writes ?? []) if (inMemoryDir(w.file, opts.memoryDirs)) store.anchor(machine, f.session, path.resolve(w.file), w.at, 'capture')
      }
    })

    let pending: Buffer = Buffer.alloc(0)
    let pos = c.offset
    while (pos < st.size && !c.skipped) {
      if (opts.deadline && Date.now() > opts.deadline) break
      const chunk = readRange(fd, pos, Math.min(CHUNK, st.size - pos))
      if (!chunk.length) break
      pos += chunk.length
      const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk
      const lastNl = buf.lastIndexOf(0x0a)
      if (lastNl < 0) {
        pending = buf // one line longer than a chunk: keep reading until it ends
        continue
      }
      const complete = buf.subarray(0, lastNl + 1)
      pending = buf.subarray(lastNl + 1)
      const lines: Buffer[] = []
      let start = 0
      for (let i = 0; i < complete.length; i++) {
        if (complete[i] === 0x0a) {
          if (i > start) lines.push(complete.subarray(start, i))
          start = i + 1
        }
      }
      record(lines)
      // The cursor moves only past whole lines; a partial last line is read again next time.
      const consumed = complete.length
      const last = lines.at(-1)
      c.offset = pos - buf.length + consumed
      if (last) {
        const withNl = Buffer.concat([last, Buffer.from('\n')])
        c.tail_hash = sha(withNl)
        c.tail_len = withNl.length
      }
      c.lines += lines.length
    }
    c.state = JSON.stringify(state)
  } finally {
    fs.closeSync(fd)
  }
  c.updated_at = Date.now()
  store.saveCursor(c)
  return { path: f.path, added, done: !!c.skipped || c.offset >= st.size, ...(c.skipped ? { skipped: c.skipped } : {}), ...(restarted ? { restarted } : {}) }
}

/** Capture every transcript that is not complete, oldest first: those are nearest to cleanup. */
export const captureAll = (store: ContextStore, projectsDir: string, machine: string, opts: CaptureOptions & { feeds?: TranscriptFile[] } = {}) => {
  const files = [...transcriptFiles(projectsDir), ...(opts.feeds ?? [])]
    .map((f) => ({ f, st: (() => { try { return fs.statSync(f.path) } catch { return undefined } })() }))
    .filter((x): x is { f: TranscriptFile; st: fs.Stats } => !!x.st)
    .filter(({ f, st }) => {
      const c = store.cursor(f.path)
      return !c || (!c.skipped && c.offset < st.size) || c.offset > st.size
    })
    .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs)
  const results: FileResult[] = []
  for (const { f } of files) {
    if (opts.deadline && Date.now() > opts.deadline) break
    results.push(captureFile(store, f, machine, opts))
  }
  return { pending: files.length, results }
}

export type CaptureStatus = {
  files: number
  complete: number
  skipped: number
  incomplete: { path: string; behind: number; mtime: number }[]
  /** Not complete, and within WARN_BEFORE_DAYS of the cleanup horizon. */
  atRisk: { path: string; daysLeft: number }[]
  horizonDays: number
}

export const captureStatus = (store: ContextStore, projectsDir: string, horizonDays: number, now = Date.now()): CaptureStatus => {
  const s: CaptureStatus = { files: 0, complete: 0, skipped: 0, incomplete: [], atRisk: [], horizonDays }
  for (const f of transcriptFiles(projectsDir)) {
    let st: fs.Stats
    try {
      st = fs.statSync(f.path)
    } catch {
      continue
    }
    s.files++
    const c = store.cursor(f.path)
    if (c?.skipped) {
      s.skipped++
      continue
    }
    if (c && c.offset === st.size) {
      s.complete++
      continue
    }
    s.incomplete.push({ path: f.path, behind: st.size - (c?.offset ?? 0), mtime: Math.floor(st.mtimeMs) })
    const daysLeft = horizonDays - (now - st.mtimeMs) / DAY_MS
    if (daysLeft <= WARN_BEFORE_DAYS) s.atRisk.push({ path: f.path, daysLeft: Math.floor(daysLeft) })
  }
  s.incomplete.sort((a, b) => a.mtime - b.mtime)
  return s
}

/**
 * Backfill anchors from transcripts already captured: read each one again for
 * its memory writes only, and anchor them as capture would have. Safe to run
 * any number of times.
 */
export const backfillAnchors = (store: ContextStore, projectsDir: string, machine: string, memoryDirs: string[]): { files: number; anchors: number } => {
  let anchors = 0
  let files = 0
  for (const f of transcriptFiles(projectsDir)) {
    const c = store.cursor(f.path)
    if (!c || c.skipped) continue
    let text: string
    try {
      text = fs.readFileSync(f.path, 'utf-8')
    } catch {
      continue
    }
    files++
    const state = newState()
    for (const line of text.split('\n')) {
      if (!line.includes('tool_use')) continue
      for (const w of parseLine(line, state).writes ?? []) {
        if (inMemoryDir(w.file, memoryDirs) && store.anchor(machine, f.session, path.resolve(w.file), w.at, 'backfill')) anchors++
      }
    }
  }
  return { files, anchors }
}
