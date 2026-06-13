#!/usr/bin/env tsx
/**
 * ckn-precompact — fires when Claude Code is about to /compact (manual or
 * auto). Captures the active session's recent context as a checkpoint
 * memory file in the Cortex graph BEFORE compaction summarises and
 * discards detail. The Stop hook (ckn-sync) folds memory files into the
 * graph; we trigger it inline here so the checkpoint lands immediately —
 * if compaction wipes the in-memory state before Stop fires, the graph
 * still has it.
 *
 * The companion PostCompact hook (ckn-context) reads the project's
 * memories — including this checkpoint — and re-injects them after
 * compaction completes, so the next turn has access to what was captured.
 *
 * What gets captured: the last ~50 raw turns of the session JSONL,
 * formatted as markdown. NOT LLM-extracted (that's what /cortex-snapshot is for
 * — run it manually for richer extraction). This is a safety-net dump so
 * nothing is lost across compaction boundaries.
 */
import * as fsSync from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

const SERVER_URL = 'http://localhost:3001'
const SERVER_PORT = 3001
const MAX_RECENT_TURNS = 50
const MAX_BODY_CHARS = 7_500

// Detects a running CKN server even when its HTTP endpoint transiently
// errors. The graph DB is single-writer; if the server is alive it owns
// the writer and direct-DB access in another process would contend.
const isPortBound = (port: number, host = '127.0.0.1', timeoutMs = 200): Promise<boolean> =>
  new Promise((resolve) => {
    const s = new net.Socket()
    s.setTimeout(timeoutMs)
    const done = (v: boolean) => { s.destroy(); resolve(v) }
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
    s.connect(port, host)
  })

interface HookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  transcript_path?: string
}

interface JsonlRecord {
  type?: string
  timestamp?: string
  isSidechain?: boolean
  message?: {
    role?: string
    content?: any
    model?: string
  }
  uuid?: string
}

const readStdin = (): Promise<string> =>
  new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })

/**
 * Read the last N lines of the JSONL and extract user/assistant prose +
 * tool calls in human-readable form. Skips system metadata records.
 */
const buildCheckpointBody = (transcriptPath: string): string => {
  let raw: string
  try {
    raw = fsSync.readFileSync(transcriptPath, 'utf-8')
  } catch {
    return ''
  }
  const lines = raw.split('\n').filter(Boolean)
  // Take the tail — recent activity is what matters for compaction context.
  const tail = lines.slice(-MAX_RECENT_TURNS * 4)
  const out: string[] = []
  for (const ln of tail) {
    let obj: JsonlRecord
    try {
      obj = JSON.parse(ln) as JsonlRecord
    } catch {
      continue
    }
    if (!obj.type || obj.isSidechain) continue
    const ts = obj.timestamp ? new Date(obj.timestamp).toLocaleTimeString() : ''
    if (obj.type === 'user' && obj.message?.role === 'user') {
      const content = Array.isArray(obj.message.content) ? obj.message.content : []
      const texts = content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => String(c.text ?? ''))
        .filter((t: string) => !t.startsWith('<') && !t.startsWith('[Request'))
      if (texts.length > 0) {
        out.push(`### user · ${ts}`)
        out.push(texts.join('\n').slice(0, 600))
        out.push('')
      }
    } else if (obj.type === 'assistant') {
      const content = Array.isArray(obj.message?.content) ? obj.message!.content : []
      const texts = content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => String(c.text ?? ''))
      const tools = content
        .filter((c: any) => c.type === 'tool_use')
        .map((c: any) => `→ ${c.name ?? '?'}`)
      if (texts.length > 0 || tools.length > 0) {
        out.push(`### assistant · ${ts}`)
        if (texts.length > 0) out.push(texts.join('\n').slice(0, 600))
        if (tools.length > 0) out.push(tools.join(', '))
        out.push('')
      }
    }
  }
  // Cap the total body so a single checkpoint doesn't overwhelm the graph.
  const joined = out.join('\n').trim()
  return joined.length > MAX_BODY_CHARS ? joined.slice(0, MAX_BODY_CHARS) + '\n…' : joined
}

const encodeCwd = (cwd: string): string => cwd.replace(/[/\\:]/g, '-')

/**
 * Walk up from cwd looking for the project encoding that actually has a
 * memory dir under ~/.claude/projects/<encoded>/. Falls back to the
 * exact cwd encoding when no ancestor matches — sync.ts will create
 * the dir if missing.
 */
const resolveProjectMemoryDir = (cwd: string): string => {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  let p = cwd
  while (p && p !== '/' && p.length > 1) {
    const candidate = path.join(projectsRoot, encodeCwd(p), 'memory')
    try {
      if (fsSync.statSync(path.dirname(candidate)).isDirectory()) {
        return candidate
      }
    } catch {
      // not yet — keep walking up
    }
    const i = p.lastIndexOf('/')
    if (i <= 0) break
    p = p.slice(0, i)
  }
  // Nothing matched — return the exact cwd encoding; sync will mkdir.
  return path.join(projectsRoot, encodeCwd(cwd), 'memory')
}

/**
 * Trigger an immediate graph sync so the checkpoint lands before
 * compaction strips context. Tries the API first; falls back to spawning
 * the direct-path script only when no server is bound to port 3001.
 * Either way the memory file on disk persists so a later sync picks it up.
 */
const triggerSync = async (): Promise<void> => {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5_000)
    const res = await fetch(`${SERVER_URL}/api/graph/sync`, {
      method: 'POST',
      signal: ctrl.signal,
    })
    clearTimeout(t)
    if (res.ok) return
  } catch {
    // fall through to fallback decision
  }
  // HTTP failed. If something is bound to the server port the server is
  // alive and owns the writer — a direct-DB fallback would contend.
  // Bail silently; the checkpoint .md is on disk and the next successful
  // sync will fold it in.
  if (await isPortBound(SERVER_PORT)) return
  if (process.env.CKN_FORCE_SERVER === '1') return
  // No server listening — safe to spawn ckn-sync's direct-DB path.
  // Detached + unrefed so compaction doesn't block on it.
  try {
    const tsx = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx')
    const script = path.join(PROJECT_ROOT, 'bin', 'ckn-sync.ts')
    const child = spawn(tsx, [script], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch {
    // best-effort — the file is on disk, the next Stop hook will sync it
  }
}

const main = async () => {
  const raw = await readStdin()
  let input: HookInput = {}
  try {
    input = JSON.parse(raw) as HookInput
  } catch {
    return
  }
  const sessionId = input.session_id ?? 'unknown'
  const cwd = input.cwd ?? process.cwd()
  const transcriptPath = input.transcript_path

  const body = transcriptPath ? buildCheckpointBody(transcriptPath) : ''
  if (!body) {
    // Nothing useful to checkpoint — bail silently rather than write an
    // empty memory file.
    return
  }

  const memoryDir = resolveProjectMemoryDir(cwd)
  const ts = Date.now()
  const isoTime = new Date(ts).toISOString().replace(/[:.]/g, '-')
  const slug = `precompact-${sessionId.slice(0, 8)}-${isoTime}`
  const file = path.join(memoryDir, `${slug}.md`)

  const frontmatter = [
    '---',
    `name: ${slug}`,
    `description: Pre-compaction checkpoint from session ${sessionId.slice(0, 8)} — last ~${MAX_RECENT_TURNS} turns captured before /compact stripped context.`,
    `type: memory`,
    `kind: precompact-checkpoint`,
    `session_id: ${sessionId}`,
    `cwd: ${cwd}`,
    `captured_at: ${new Date(ts).toISOString()}`,
    '---',
    '',
    `# Pre-compact checkpoint`,
    '',
    `Auto-captured by Cortex before \`/compact\` summarised the session. Raw user/assistant exchange + tool calls follow. For richer LLM-extracted memories, use \`/cortex-snapshot\` interactively before invoking \`/compact\`.`,
    '',
    body,
    '',
  ].join('\n')

  try {
    await fsp.mkdir(memoryDir, { recursive: true })
    await fsp.writeFile(file, frontmatter, 'utf-8')
  } catch {
    // If we can't write, the hook silently no-ops rather than block compaction.
    return
  }

  // Sync inline so PostCompact can see the checkpoint when it injects
  // project memories. Detached fallback handles the no-server case.
  await triggerSync()
}

main().catch(() => {
  // Hooks must never throw — Claude Code surfaces errors loudly and we
  // do NOT want a checkpoint failure to block /compact.
})
