/**
 * Server-side sessions: scans `~/.claude/projects/<encoded>/<id>.jsonl`,
 * parses metadata, tracks per-file last-write timestamps for the liveness
 * indicator, and streams new lines over WebSocket as they're written.
 *
 * Liveness tiers (driven by file mtime relative to now):
 *   < 60s   → live      (green pulse)
 *   < 120s  → stale     (yellow glow)
 *   < 300s  → idle      (dim red)
 *   < 12h   → dormant   (continues as idle visually)
 *   ≥ 12h   → ancient   (grey)
 *
 * Auto-pin on the client tab strip is permitted only for live/stale/idle.
 * Dormant + ancient must be user-pinned to appear.
 */
import fs from 'node:fs/promises'
import { createReadStream, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createInterface } from 'node:readline'

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

export type LiveState = 'live' | 'stale' | 'idle' | 'ancient'

export const stateForAge = (ageMs: number): LiveState => {
  if (ageMs < 60_000) return 'live'
  if (ageMs < 120_000) return 'stale'
  if (ageMs < 12 * 3_600_000) return 'idle'
  return 'ancient'
}

export const isAutoPinnable = (state: LiveState): boolean =>
  state === 'live' || state === 'stale' || state === 'idle'

export interface SessionMeta {
  id: string                 // session UUID (filename without .jsonl)
  projectDir: string         // encoded project dir name (e.g. -mnt-e-Repos-personal)
  filePath: string           // absolute path to JSONL
  title: string              // ai-title or fallback
  startTime: string          // first message timestamp
  lastTime: string           // last message timestamp
  turnCount: number          // user turns
  tokenCount: number         // sum of input + output tokens
  fileSize: number           // bytes
  lineCount: number          // number of lines in file
  mtimeMs: number            // file mtime in ms
  liveState: LiveState
  model?: string             // last seen assistant model id
}

export interface ParsedLine {
  /** Zero-based line offset within the file. */
  line: number
  /** ISO timestamp from the JSONL record, if present. */
  timestamp: string
  /** Discriminator drives client rendering. */
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'meta' | 'other'
  /** Display text — single short line, never multi-paragraph. */
  text: string
  /** Tool name when type === 'tool_use' or 'tool_result'. */
  tool?: string
  /** Tool result error flag — drives the ✗ vs ✓ glyph. */
  isError?: boolean
  /** Tool-use IDs let the client correlate calls with their results. */
  toolUseId?: string
  /** Original assistant model when present, for HUD. */
  model?: string
}

const FALLBACK_TITLE = (id: string) => id.slice(0, 8)

const summariseToolInput = (name: string, input: any): string => {
  if (!input || typeof input !== 'object') return ''
  // Common tool args we want compact 1-line summaries of.
  if (name === 'Bash') return String(input.command ?? '').slice(0, 80)
  if (name === 'Read') return String(input.file_path ?? input.path ?? '').slice(0, 80)
  if (name === 'Edit') return String(input.file_path ?? input.path ?? '').slice(0, 80)
  if (name === 'Write') return String(input.file_path ?? input.path ?? '').slice(0, 80)
  if (name === 'Glob') return String(input.pattern ?? '').slice(0, 80)
  if (name === 'Grep') return String(input.pattern ?? '').slice(0, 80)
  if (name === 'WebFetch') return String(input.url ?? '').slice(0, 80)
  if (name === 'WebSearch') return String(input.query ?? '').slice(0, 80)
  // Generic fallback: stringify the first scalar value we find.
  for (const v of Object.values(input)) {
    if (typeof v === 'string') return v.slice(0, 80)
  }
  return ''
}

const isSystemInjection = (text: string): boolean => {
  const t = text.trimStart()
  return (
    t.startsWith('<ide_') ||
    t.startsWith('<system') ||
    t.startsWith('<user-prompt') ||
    t.startsWith('<command-') ||
    t.startsWith('<parameter name="')
  )
}

const extractResultText = (c: any): string => {
  if (typeof c.content === 'string') return c.content
  if (Array.isArray(c.content)) {
    return c.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
      .join(' ')
  }
  return ''
}

/**
 * Parse a single JSONL line into one or more ParsedLine entries. A single
 * record can yield several entries (e.g. an assistant message with text +
 * 2 tool_use blocks → one assistant + two tool_use lines).
 */
const parseRecord = (line: number, raw: string): ParsedLine[] => {
  let obj: any
  try {
    obj = JSON.parse(raw)
  } catch {
    return []
  }
  const ts = String(obj.timestamp ?? '')
  const out: ParsedLine[] = []

  if (obj.type === 'user' && !obj.isSidechain && obj.message?.role === 'user') {
    const content = Array.isArray(obj.message.content) ? obj.message.content : []
    const texts = content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text as string)
      .filter((t: string) => !isSystemInjection(t))
    if (texts.length > 0) {
      out.push({
        line,
        timestamp: ts,
        type: 'user',
        text: texts.join(' ').slice(0, 200),
      })
    }
    // tool_results live inside user-role messages too.
    for (const c of content) {
      if (c.type === 'tool_result' && c.tool_use_id) {
        const text = extractResultText(c).replace(/\s+/g, ' ').slice(0, 80)
        out.push({
          line,
          timestamp: ts,
          type: 'tool_result',
          text,
          toolUseId: c.tool_use_id,
          isError: !!c.is_error,
        })
      }
    }
  } else if (obj.type === 'assistant' && !obj.isSidechain) {
    const content = Array.isArray(obj.message?.content) ? obj.message.content : []
    const texts = content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text as string)
    const model = obj.message?.model
    if (texts.length > 0) {
      out.push({
        line,
        timestamp: ts,
        type: 'assistant',
        text: texts.join(' ').slice(0, 200),
        model,
      })
    }
    for (const c of content) {
      if (c.type === 'tool_use') {
        const arg = summariseToolInput(c.name, c.input)
        out.push({
          line,
          timestamp: ts,
          type: 'tool_use',
          tool: c.name,
          text: arg,
          toolUseId: c.id,
          model,
        })
      }
    }
  } else if (obj.type === 'ai-title' && obj.aiTitle) {
    out.push({ line, timestamp: ts, type: 'meta', text: `title: ${obj.aiTitle}` })
  } else if (obj.type === 'custom-title' && obj.customTitle) {
    out.push({ line, timestamp: ts, type: 'meta', text: `title: ${obj.customTitle}` })
  }
  return out
}

const readJsonl = async (filePath: string): Promise<{ lines: ParsedLine[]; rawCount: number }> => {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const lines: ParsedLine[] = []
  let rawCount = 0
  for await (const raw of rl) {
    if (!raw) {
      rawCount++
      continue
    }
    const entries = parseRecord(rawCount, raw)
    lines.push(...entries)
    rawCount++
  }
  return { lines, rawCount }
}

/**
 * Lightweight metadata pass — reads the file once, extracts title, time
 * bounds, turn count, token count, last model. Avoids buffering the full
 * parsed message stream in memory; that's only loaded on demand by the
 * /range endpoint.
 */
const computeMeta = async (filePath: string, sessionId: string): Promise<{
  title: string
  startTime: string
  lastTime: string
  turnCount: number
  tokenCount: number
  lineCount: number
  model?: string
}> => {
  let aiTitle = ''
  let customTitle = ''
  let agentName = ''
  let startTime = ''
  let lastTime = ''
  let turnCount = 0
  let tokenCount = 0
  let lineCount = 0
  let model: string | undefined

  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const raw of rl) {
    lineCount++
    if (!raw) continue
    let obj: any
    try {
      obj = JSON.parse(raw)
    } catch {
      continue
    }
    if (obj.timestamp) {
      if (!startTime || obj.timestamp < startTime) startTime = obj.timestamp
      if (!lastTime || obj.timestamp > lastTime) lastTime = obj.timestamp
    }
    // Title precedence (last-write-wins, then resolved by precedence below):
    //   custom-title  — user-set via /name; the authoritative one
    //   ai-title      — auto-generated summary
    //   agent-name    — set when launched as a sub-agent
    if (obj.type === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle
    if (obj.type === 'custom-title' && obj.customTitle) customTitle = obj.customTitle
    if (obj.type === 'agent-name' && obj.agentName) agentName = obj.agentName
    if (obj.type === 'user' && !obj.isSidechain && obj.message?.role === 'user') turnCount++
    if (obj.type === 'assistant' && !obj.isSidechain) {
      if (obj.message?.model) model = obj.message.model
      const u = obj.message?.usage
      if (u) tokenCount += (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
    }
  }
  // Custom title wins because the user set it explicitly. Fall back to the
  // ai-generated summary, then the agent name (rare), then a uuid stub.
  const title = customTitle || aiTitle || agentName || FALLBACK_TITLE(sessionId)
  return { title, startTime, lastTime, turnCount, tokenCount, lineCount, model }
}

/**
 * Walk every project dir under ~/.claude/projects/<encoded>/ and collect
 * one SessionMeta per .jsonl. Sorted by mtime desc so the most-recent
 * sessions land at the top of the picker.
 */
export const listSessions = async (): Promise<SessionMeta[]> => {
  const projectsExist = await fs.access(PROJECTS_DIR).then(() => true).catch(() => false)
  if (!projectsExist) return []
  const projectEntries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true })
  const out: SessionMeta[] = []
  for (const proj of projectEntries) {
    if (!proj.isDirectory()) continue
    const projDir = path.join(PROJECTS_DIR, proj.name)
    let files: string[] = []
    try {
      files = (await fs.readdir(projDir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      const filePath = path.join(projDir, file)
      try {
        const stat = await fs.stat(filePath)
        const id = file.slice(0, -6) // strip ".jsonl"
        const meta = await computeMeta(filePath, id)
        const ageMs = Date.now() - stat.mtimeMs
        out.push({
          id,
          projectDir: proj.name,
          filePath,
          title: meta.title,
          startTime: meta.startTime,
          lastTime: meta.lastTime,
          turnCount: meta.turnCount,
          tokenCount: meta.tokenCount,
          fileSize: stat.size,
          lineCount: meta.lineCount,
          mtimeMs: stat.mtimeMs,
          liveState: stateForAge(ageMs),
          model: meta.model,
        })
      } catch {
        // ignore unreadable file
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/**
 * Read parsed lines from a session's JSONL. `sinceLine` is the raw-line
 * offset; the response includes its own next-cursor (`nextLine`) so the
 * client can poll forward incrementally. Limits at 5000 to keep responses
 * bounded for very long sessions.
 */
export const readSessionRange = async (
  projectDir: string,
  sessionId: string,
  sinceLine = 0,
  limit = 5000,
): Promise<{ lines: ParsedLine[]; nextLine: number; eof: boolean }> => {
  const filePath = path.join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`)
  const exists = await fs.access(filePath).then(() => true).catch(() => false)
  if (!exists) return { lines: [], nextLine: sinceLine, eof: true }

  const { lines, rawCount } = await readJsonl(filePath)
  const filtered = lines.filter((l) => l.line >= sinceLine).slice(0, limit)
  const lastLine = filtered.length > 0 ? filtered[filtered.length - 1]!.line : sinceLine - 1
  return {
    lines: filtered,
    nextLine: Math.max(lastLine + 1, sinceLine),
    eof: lastLine + 1 >= rawCount,
  }
}

/**
 * Best-effort sync metadata for a single file — used by the watcher when
 * a write event fires so the broadcast can include up-to-date stats. Skips
 * the metadata pass if the caller already has fresh values.
 */
export const sessionMetaFor = async (
  projectDir: string,
  sessionId: string,
): Promise<SessionMeta | null> => {
  const filePath = path.join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`)
  try {
    const stat = statSync(filePath)
    const meta = await computeMeta(filePath, sessionId)
    return {
      id: sessionId,
      projectDir,
      filePath,
      title: meta.title,
      startTime: meta.startTime,
      lastTime: meta.lastTime,
      turnCount: meta.turnCount,
      tokenCount: meta.tokenCount,
      fileSize: stat.size,
      lineCount: meta.lineCount,
      mtimeMs: stat.mtimeMs,
      liveState: stateForAge(Date.now() - stat.mtimeMs),
      model: meta.model,
    }
  } catch {
    return null
  }
}

/**
 * Map a path under PROJECTS_DIR to its (projectDir, sessionId) pair, or
 * null if the path isn't a session JSONL. Used by the watcher to decide
 * whether a write event is session-relevant.
 */
export const sessionRefFromPath = (
  fullPath: string,
): { projectDir: string; sessionId: string } | null => {
  const norm = fullPath.replace(/\\/g, '/')
  const projects = PROJECTS_DIR.replace(/\\/g, '/')
  if (!norm.startsWith(projects + '/')) return null
  if (!norm.endsWith('.jsonl')) return null
  const rest = norm.slice(projects.length + 1)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const projectDir = rest.slice(0, slash)
  const file = rest.slice(slash + 1)
  // Skip nested files (e.g. memory/*.md) — we only care about top-level *.jsonl.
  if (file.includes('/')) return null
  return { projectDir, sessionId: file.slice(0, -6) }
}
