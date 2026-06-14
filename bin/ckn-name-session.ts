#!/usr/bin/env tsx
/**
 * ckn-name-session — set the topic name for a Claude Code session.
 *
 * Claude Code natively supports session naming via a `custom-title` event
 * in the session JSONL (`{"type":"custom-title","customTitle":"...","sessionId":"..."}`).
 * CC writes this event itself at launch (when `-n` is supplied) and at
 * periodic checkpoints during the session. The latest one wins for display
 * in /resume picker, prompt box, and terminal title. The title persists
 * across --resume/-c chains automatically.
 *
 * This script appends a `custom-title` event to the current JSONL. No
 * markdown files, no frontmatter, no inheritance scan — Claude Code already
 * propagates the title across resumes natively.
 *
 * Usage:
 *   ckn-name-session --current --cwd <path> --name "<topic>"
 *   ckn-name-session --session-id <sid> --cwd <path> --name "<topic>"
 *   ckn-name-session --current --cwd <path> --auto    # YYYY-MM-DD-NNN fallback
 *
 * SID resolution: `--current` picks the most-recently-modified .jsonl
 * under ~/.claude/projects/<encoded-cwd>/.
 */
import * as fsSync from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { resolveAnthropicKey } from './_anthropic-key.js'
import { projectDirForSession, resolveSelfSessionId } from './_session-id.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const COUNTER_PATH = path.join(os.homedir(), '.config', 'ckn', 'auto-name-counter.json')
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const execFileP = promisify(execFile)

interface Args {
  sessionId: string
  name: string | null
  auto: boolean
  cwd: string | null
  current: boolean
}

const parseArgs = (): Args => {
  const argv = process.argv.slice(2)
  const out: Args = { sessionId: '', name: null, auto: false, cwd: null, current: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session-id') out.sessionId = argv[++i] ?? ''
    else if (a === '--name') out.name = argv[++i] ?? null
    else if (a === '--auto') out.auto = true
    else if (a === '--cwd') out.cwd = argv[++i] ?? null
    else if (a === '--current') out.current = true
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage:\n' +
          '  ckn-name-session --current --cwd <path> --name "<topic>"\n' +
          '  ckn-name-session --session-id <sid> --cwd <path> --name "<topic>"\n' +
          '  ckn-name-session --current --cwd <path> --auto      # YYYY-MM-DD-NNN fallback',
      )
      process.exit(0)
    }
  }
  return out
}

const todayDate = (): string => new Date().toISOString().slice(0, 10)

const nextAutoName = async (): Promise<string> => {
  interface CounterState {
    byDate: Record<string, number>
  }
  let state: CounterState
  try {
    state = JSON.parse(await fsp.readFile(COUNTER_PATH, 'utf-8'))
  } catch {
    state = { byDate: {} }
  }
  const today = todayDate()
  const next = (state.byDate[today] ?? 0) + 1
  state.byDate[today] = next
  await fsp.mkdir(path.dirname(COUNTER_PATH), { recursive: true })
  await fsp.writeFile(COUNTER_PATH, JSON.stringify(state, null, 2), 'utf-8')
  return `${today}-${String(next).padStart(3, '0')}`
}

// ── topic extraction (deterministic-first, LLM-optional) ─────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'was', 'were',
  'i', 'we', 'you', 'it', 'this', 'that', 'my', 'our', 'your', 'please', 'can', 'could',
  'help', 'me', 'with', 'let', 'lets', 'need', 'want', 'have', 'has', 'do', 'does', 'get',
  'make', 'add', 'fix', 'update', 'change', 'set', 'use', 'using', 'run', 'about',
])

const slugify = (s: string, maxWords = 6): string => {
  const words = s
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return ''
  const meaningful = words.filter((w) => !STOPWORDS.has(w))
  const pick = (meaningful.length >= 2 ? meaningful : words).slice(0, maxWords)
  return pick.join('-').slice(0, 60).replace(/-+$/, '')
}

/**
 * First genuine user prompt from the JSONL. Skips Claude Code's synthetic meta
 * turns: tool_result chunks, command/system-reminder blocks (text starting with
 * '<'), and [Request interrupted...] markers.
 */
const firstUserPrompt = async (jsonlPath: string): Promise<string | null> => {
  let raw: string
  try {
    raw = await fsp.readFile(jsonlPath, 'utf-8')
  } catch {
    return null
  }
  for (const ln of raw.split('\n')) {
    if (!ln) continue
    let obj: any
    try {
      obj = JSON.parse(ln)
    } catch {
      continue
    }
    if (obj?.isSidechain) continue
    if (obj?.type !== 'user' || obj?.message?.role !== 'user') continue
    const content = obj.message.content
    const chunks = Array.isArray(content)
      ? content
      : typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : []
    for (const c of chunks) {
      if (c?.type !== 'text') continue
      const txt = String(c.text ?? '').trim()
      if (!txt || txt.startsWith('<') || txt.startsWith('[Request')) continue
      return txt
    }
  }
  return null
}

/**
 * Slugs of memory .md files created/modified during this session. We approximate
 * "this session" by files newer than the JSONL's birthtime (12h window when
 * birthtime is unavailable, e.g. WSL/ext4). Best-effort — never throws. Usually
 * empty at a fresh session's start (ckn-extract writes memories at SessionEnd).
 */
const sessionMemorySlugs = async (jsonlPath: string): Promise<string[]> => {
  // Co-located with the (resolver-correct) transcript so a subdir cwd reads the
  // real project's memories, not an empty encode(subdir) dir.
  const memDir = path.join(path.dirname(jsonlPath), 'memory')
  let sessionStart = 0
  try {
    const st = await fsp.stat(jsonlPath)
    sessionStart = st.birthtimeMs || st.ctimeMs || 0
  } catch {}
  if (!sessionStart) sessionStart = Date.now() - 12 * 60 * 60 * 1000
  let entries: fsSync.Dirent[]
  try {
    entries = await fsp.readdir(memDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: { slug: string; mtime: number }[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    // Skip machine-generated checkpoint memories — they're named by session-id +
    // timestamp, not topic, so they'd produce a useless name. Only curated topic
    // memories make good session names.
    if (e.name.startsWith('session-') || e.name.startsWith('precompact-')) continue
    try {
      const st = await fsp.stat(path.join(memDir, e.name))
      if (st.mtimeMs < sessionStart) continue
      const base = e.name.slice(0, -'.md'.length)
      const slug = base.replace(/^[a-z]+-/, '') // strip "<kind>-" prefix
      out.push({ slug, mtime: st.mtimeMs })
    } catch {}
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out.map((o) => o.slug)
}

/** Commit subjects authored during the session window in `cwd`'s repo. */
const sessionGitTitles = async (cwd: string, jsonlPath: string): Promise<string[]> => {
  let sessionStart = 0
  try {
    const st = await fsp.stat(jsonlPath)
    sessionStart = st.birthtimeMs || st.ctimeMs || 0
  } catch {}
  if (!sessionStart) sessionStart = Date.now() - 12 * 60 * 60 * 1000
  const sinceIso = new Date(sessionStart).toISOString()
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', cwd, 'log', '--since', sinceIso, '--pretty=%s', '--no-merges', '-n', '20'],
      { timeout: 4000 },
    )
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Best-effort Haiku refinement. Degrades to null on no key / error / timeout so
 * callers fall through to the heuristic candidate. maxRetries:0 + a request
 * timeout bound the interactive latency.
 */
const refineWithHaiku = async (signals: {
  prompt: string | null
  memorySlugs: string[]
  gitTitles: string[]
}): Promise<string | null> => {
  const apiKey = await resolveAnthropicKey()
  if (!apiKey) return null
  const ctx = [
    signals.prompt ? `First user message: ${signals.prompt.slice(0, 400)}` : '',
    signals.memorySlugs.length ? `Memories created: ${signals.memorySlugs.slice(0, 8).join(', ')}` : '',
    signals.gitTitles.length ? `Commits: ${signals.gitTitles.slice(0, 8).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  if (!ctx) return null
  const client = new Anthropic({ apiKey, maxRetries: 0 })
  try {
    const resp = await client.messages.create(
      {
        model: HAIKU_MODEL,
        max_tokens: 32,
        system:
          'You name a Claude Code coding session by its topic. Output ONLY a short ' +
          'hyphenated slug (2-6 lowercase words, no spaces, no punctuation other than ' +
          'hyphens), e.g. "graph-write-lock-fix". No prose, no quotes.',
        messages: [{ role: 'user', content: ctx }],
      },
      { timeout: 8000 },
    )
    let text = ''
    for (const block of resp.content) if (block.type === 'text') text += block.text
    return slugify(text, 6) || null
  } catch (e: any) {
    console.warn(`[ckn name-session] Haiku refine failed: ${e?.message ?? e}`)
    return null
  }
}

/**
 * Topic-based auto name with a deterministic fallback chain:
 *   1. memory slug created this session   2. first user prompt
 *   3. session git commit subject          4. timestamp (nextAutoName)
 * When ANTHROPIC_API_KEY is set, a candidate from 1-3 is offered to Haiku for a
 * cleaner slug; Haiku output replaces the candidate only when non-empty.
 */
const deriveAutoName = async (sid: string, cwd: string): Promise<string> => {
  const jsonlPath = resolveJsonlPath(sid, cwd)
  const [prompt, memorySlugs, gitTitles] = await Promise.all([
    firstUserPrompt(jsonlPath),
    sessionMemorySlugs(jsonlPath),
    sessionGitTitles(cwd, jsonlPath),
  ])

  let candidate = ''
  if (memorySlugs[0]) candidate = slugify(memorySlugs[0].replace(/-/g, ' '), 6)
  if (!candidate && prompt) candidate = slugify(prompt, 6)
  if (!candidate && gitTitles[0]) candidate = slugify(gitTitles[0], 6)

  if (candidate) {
    const refined = await refineWithHaiku({ prompt, memorySlugs, gitTitles })
    if (refined) candidate = refined
  }

  return candidate || (await nextAutoName()) // timestamp terminal fallback
}

const resolveJsonlPath = (sid: string, cwd: string): string =>
  path.join(projectDirForSession(sid, cwd), `${sid}.jsonl`)

/**
 * Append a `custom-title` event to the JSONL. Matches Claude Code's own
 * event format exactly — CC writes the same shape itself, multiple times
 * per session, so an extra append is structurally identical to a CC
 * heartbeat write.
 */
const appendCustomTitle = async (jsonlPath: string, sid: string, title: string): Promise<void> => {
  const evt = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: sid }) + '\n'
  await fsp.appendFile(jsonlPath, evt, 'utf-8')
}

const triggerSync = (): void => {
  try {
    const tsx = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx')
    const script = path.join(__dirname, 'ckn-sync.ts')
    const child = spawn(tsx, [script], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {}
}

const main = async (): Promise<void> => {
  const args = parseArgs()
  if (!args.cwd) {
    console.error('[ckn name-session] --cwd is required (typically pass "$PWD")')
    process.exit(2)
  }
  if (args.current && !args.sessionId) {
    // Transcript-first (NOT mtime): resolveSelfSessionId trusts the env id when its
    // <id>.jsonl validates and structurally excludes continue/compact PHANTOMS (a phantom
    // only ever has a tool-results/ dir, never a depth-2 <uuid>.jsonl). The old mtime pick
    // could name the phantom post-compact (#47 / cortex-identity-fix-incomplete-name-paths).
    // cwd-encoding skew between the transcript dir and $PWD is a tracked SEPARATE follow-up
    // FR, out of scope here.
    const detected = resolveSelfSessionId({ env: process.env.CLAUDE_CODE_SESSION_ID }).sessionId
    if (!detected) {
      console.error(
        `[ckn name-session] --current: could not resolve this session id (no validated transcript). Pass --session-id explicitly.`,
      )
      process.exit(2)
    }
    args.sessionId = detected
  }
  if (!args.sessionId) {
    console.error('[ckn name-session] --session-id (or --current) is required')
    process.exit(2)
  }
  if (!args.auto && !args.name) {
    console.error('[ckn name-session] one of --name "<text>" or --auto is required')
    process.exit(2)
  }

  const title = args.auto
    ? await deriveAutoName(args.sessionId, args.cwd!)
    : (args.name ?? '').trim()
  if (!title) {
    console.error('[ckn name-session] resolved name was empty')
    process.exit(2)
  }

  const jsonlPath = resolveJsonlPath(args.sessionId, args.cwd)
  if (!fsSync.existsSync(jsonlPath)) {
    console.error(
      `[ckn name-session] no JSONL at ${jsonlPath} — wrong --cwd, or session not yet persisted.`,
    )
    process.exit(2)
  }

  await appendCustomTitle(jsonlPath, args.sessionId, title)
  triggerSync()

  console.log(
    `[ckn name-session] session ${args.sessionId.slice(0, 8)} → "${title}" (${args.auto ? 'auto' : 'user'})`,
  )
}

main().catch((e) => {
  console.error('[ckn name-session] fatal:', e?.message ?? e)
  process.exit(1)
})
