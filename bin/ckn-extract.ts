#!/usr/bin/env tsx
/**
 * ckn-extract — SessionEnd hook target. Pulls structured memory out of a
 * Claude Code session JSONL and writes typed .md files.
 *
 * Verbatim-anchored extraction: the LLM categorizes events (decision,
 * error, workflow, reference, topic) and points at specific tool_use IDs
 * or assistant turn indices. Deterministic code then copies the
 * **verbatim** text from the JSONL by ID — error strings, tool args,
 * outcome text — into the resulting memory files. The LLM never invents
 * outcome content; only structure and labels.
 *
 * Authorship is set from env:
 *   CKN_AGENT_ID     — agent UUID (orchestrator sets this for headless
 *                      agents); empty for human-driven sessions
 *   CKN_AUTHORSHIP   — override for the authorship field; defaults to
 *                      'auto-extracted' (or 'agent' when AGENT_ID is set)
 *
 * No server dependency: this script reads ANTHROPIC_API_KEY directly,
 * calls the API, and writes files. Falls back to a transcript-only
 * heuristic extractor when no API key is set so SessionEnd never fails.
 *
 *
 * Usage:
 *   bin/ckn-extract.ts                            (hook mode — reads stdin JSON)
 *   bin/ckn-extract.ts --backfill [N]             (reprocess last N JSONLs)
 *   bin/ckn-extract.ts --session <projDir> <sid>  (one specific session)
 */
import * as fsSync from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { resolveAnthropicKey } from './_anthropic-key.js'
import { getMachineId } from '../server/privateMind.js'
import { SERVER_URL } from './_graph-guard.js'
import { projectDirForSession } from './_session-id.js'
import {
  type ProfileFacetCandidate,
  FACET_SYSTEM_PROMPT,
  parseFacetResponse,
} from './_profile-facets.js'

// ESM doesn't expose __dirname; derive from import.meta. Without this
// the spawn-detached ckn-sync trigger blows up at runtime.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const MAX_INPUT_TOKENS_BUDGET = 60_000
const MAX_OUTPUT_TOKENS = 4_000
const MIN_TURNS_TO_EXTRACT = 5
// SERVER_URL is imported from _graph-guard so the module-scope profile POST
// and the dynamically-imported graph-guard usages (contradictions, bus
// sign-off) all resolve the same value.

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
  uuid?: string
  message?: {
    role?: string
    content?: any
    model?: string
  }
}

/**
 * Compact representation of a turn in the transcript. Each gets a stable
 * `tag` we hand to the LLM so it can point back to it.
 */
interface Turn {
  tag: string
  role: 'user' | 'assistant' | 'tool_result'
  ts: string
  text?: string
  toolUseId?: string
  toolName?: string
  toolArgs?: string
  isError?: boolean
}

const readStdin = (): Promise<string> =>
  new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })

// ── transcript parsing ──────────────────────────────────────────────────────

const parseTranscript = (transcriptPath: string): Turn[] => {
  let raw: string
  try {
    raw = fsSync.readFileSync(transcriptPath, 'utf-8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter(Boolean)
  const turns: Turn[] = []
  let idx = 0
  for (const ln of lines) {
    let obj: JsonlRecord
    try {
      obj = JSON.parse(ln) as JsonlRecord
    } catch {
      continue
    }
    if (!obj.type || obj.isSidechain) continue
    const ts = obj.timestamp ?? ''
    if (obj.type === 'user' && obj.message?.role === 'user') {
      const content = Array.isArray(obj.message.content) ? obj.message.content : []
      // tool_result chunks carry tool outputs back to the model
      for (const c of content) {
        if (c?.type === 'tool_result') {
          const text =
            typeof c.content === 'string'
              ? c.content
              : Array.isArray(c.content)
                ? c.content
                    .filter((x: any) => x?.type === 'text')
                    .map((x: any) => String(x.text ?? ''))
                    .join('\n')
                : ''
          turns.push({
            tag: `t${++idx}`,
            role: 'tool_result',
            ts,
            text: text.slice(0, 2000),
            toolUseId: c.tool_use_id ?? '',
            isError: !!c.is_error,
          })
        } else if (c?.type === 'text') {
          const txt = String(c.text ?? '')
          if (txt && !txt.startsWith('<') && !txt.startsWith('[Request')) {
            turns.push({
              tag: `t${++idx}`,
              role: 'user',
              ts,
              text: txt.slice(0, 2000),
            })
          }
        }
      }
    } else if (obj.type === 'assistant') {
      const content = Array.isArray(obj.message?.content) ? obj.message!.content : []
      for (const c of content) {
        if (c?.type === 'text') {
          turns.push({
            tag: `t${++idx}`,
            role: 'assistant',
            ts,
            text: String(c.text ?? '').slice(0, 2000),
          })
        } else if (c?.type === 'tool_use') {
          turns.push({
            tag: `t${++idx}`,
            role: 'assistant',
            ts,
            toolUseId: c.id ?? '',
            toolName: c.name ?? '',
            toolArgs: JSON.stringify(c.input ?? {}).slice(0, 1500),
          })
        }
      }
    }
  }
  return turns
}

// ── compact transcript for the LLM ──────────────────────────────────────────

const renderTranscriptForLlm = (turns: Turn[]): string => {
  const lines: string[] = []
  for (const t of turns) {
    if (t.role === 'user') {
      lines.push(`[${t.tag}] USER: ${(t.text ?? '').slice(0, 400)}`)
    } else if (t.role === 'assistant' && t.text) {
      lines.push(`[${t.tag}] ASSISTANT: ${(t.text ?? '').slice(0, 400)}`)
    } else if (t.role === 'assistant' && t.toolName) {
      lines.push(`[${t.tag}] TOOL_USE ${t.toolName}(${(t.toolArgs ?? '').slice(0, 200)})`)
    } else if (t.role === 'tool_result') {
      const status = t.isError ? 'ERROR' : 'ok'
      lines.push(`[${t.tag}] TOOL_RESULT(${status}): ${(t.text ?? '').slice(0, 300)}`)
    }
  }
  return lines.join('\n')
}

// ── extraction schemas ─────────────────────────────────────────────────────

interface ExtractedMemory {
  /** Stable kind from docs/reference/graph-schema.md */
  kind: 'decision' | 'workflow' | 'error' | 'reference' | 'topic' | 'note'
  /** Short slug for the filename — hyphenated, no spaces */
  slug: string
  /** Human-readable title */
  name: string
  /** One-line description */
  description: string
  /** Outcome — success/failure/unknown */
  outcome: 'success' | 'failure' | 'unknown'
  /** Tags pointing at the verbatim turns this memory anchors to. Code
   *  lifts the verbatim text from these tags into the memory body. */
  anchor_tags: string[]
  /** Files mentioned in this memory's anchor tags — extracted from tool
   *  args by deterministic code, never invented by the LLM */
  mentions_files?: string[]
  /** Tools mentioned */
  mentions_tools?: string[]
  /** Free-text body the LLM contributes — high-level summary only.
   *  Verbatim outcome text gets appended by code, not the LLM. */
  body: string
}

const SYSTEM_PROMPT = `You are an extraction engine for Cortex — a persistent memory graph for Claude Code sessions.

Given a compact transcript of a Claude Code session, identify discrete memories worth keeping for future sessions. Each memory must be one of these kinds:

- decision  — a deliberate choice made (with rejected alternatives if any)
- workflow  — a successful task pattern (problem → approach → outcome)
- error     — an error that was hit and NOT resolved in this session
- reference — an external resource (URL, doc, named service) discussed
- topic     — a domain/topic the session focused on
- note      — anything else worth remembering that doesn't fit above

For each memory, output:
- kind: one of the above
- slug: short hyphenated filename slug (no spaces, lowercase)
- name: human-readable title
- description: one-line summary, ~120 chars
- outcome: 'success', 'failure', or 'unknown'
- anchor_tags: a list of [tag] references from the transcript that this memory is grounded in. These are the verbatim source — your description and body should be a *labeling* of these turns, not paraphrased content
- mentions_files: file paths the anchor tags reference (extract from tool args, do NOT invent)
- mentions_tools: tool names the anchor tags use
- body: 2-4 sentence summary at most. The verbatim outcome text will be appended automatically — do NOT paraphrase error messages, exit codes, or tool outputs.

CRITICAL RULES:
1. Never invent outcome text. If you describe a failure, point at the [tag] where the error appears — code will copy the verbatim error string.
2. mentions_files must come from actual tool args — if Edit was called on src/foo.ts, list "src/foo.ts". Do not guess paths.
3. Skip routine activity. A simple "ran tests, all passed" with no decision-content is not worth a memory. Quality over quantity.
4. Decisions are valuable when alternatives were considered. Anchor to the turns where alternatives were discussed.
5. If the session has fewer than 3 distinct memorable events, return an empty list.

Output JSON only — an object with a single "memories" array.`

interface AnchorEvidence {
  /** Verbatim outcome text from the anchored turns — copied directly from JSONL */
  outcomeText: string
  /** Tool names extracted from anchor turns */
  toolNames: string[]
  /** File paths extracted from tool args */
  filePaths: string[]
  /** Concatenated verbatim turn text for the memory body */
  evidence: string
}

/**
 * Walk the anchor tags and pull verbatim evidence — outcome strings,
 * tool args, file paths. This is what the LLM is forbidden from
 * generating; it must come from the transcript itself.
 */
const collectAnchorEvidence = (
  anchorTags: string[],
  turnsByTag: Map<string, Turn>,
): AnchorEvidence => {
  const evidenceLines: string[] = []
  const toolNames = new Set<string>()
  const filePaths = new Set<string>()
  let outcomeText = ''

  const filePathRegex = /(?:^|[\s"'`(\[])((?:\.{0,2}\/|[a-zA-Z]:[\\/]|~\/)[^\s"'`)\]]+\.(?:ts|tsx|js|jsx|json|md|py|sh|sql|yaml|yml|toml|css|html))/g

  for (const tag of anchorTags) {
    const turn = turnsByTag.get(tag)
    if (!turn) continue
    if (turn.role === 'tool_result') {
      const txt = turn.text ?? ''
      evidenceLines.push(`> [${tag}] TOOL_RESULT (${turn.isError ? 'ERROR' : 'ok'}):`)
      evidenceLines.push('> ```')
      evidenceLines.push(txt.split('\n').map((l) => `> ${l}`).join('\n'))
      evidenceLines.push('> ```')
      // Tool result with isError captures the verbatim error text — first match wins
      if (turn.isError && !outcomeText) outcomeText = txt
      // First successful result also worth surfacing
      if (!turn.isError && !outcomeText) outcomeText = txt
    } else if (turn.role === 'assistant' && turn.toolName) {
      toolNames.add(turn.toolName)
      const args = turn.toolArgs ?? ''
      evidenceLines.push(`> [${tag}] TOOL_USE ${turn.toolName}: ${args}`)
      // Pull file paths from tool args
      let m: RegExpExecArray | null
      while ((m = filePathRegex.exec(args)) !== null) {
        filePaths.add(m[1]!)
      }
    } else if (turn.text) {
      evidenceLines.push(`> [${tag}] ${turn.role.toUpperCase()}: ${turn.text}`)
    }
  }

  return {
    outcomeText: outcomeText.slice(0, 2000),
    toolNames: Array.from(toolNames),
    filePaths: Array.from(filePaths),
    evidence: evidenceLines.join('\n'),
  }
}

// ── LLM call ───────────────────────────────────────────────────────────────

const callLlm = async (
  transcript: string,
): Promise<ExtractedMemory[]> => {
  const apiKey = await resolveAnthropicKey()
  if (!apiKey) return []
  const client = new Anthropic({ apiKey })

  const truncated = transcript.length > MAX_INPUT_TOKENS_BUDGET * 4
    ? transcript.slice(-MAX_INPUT_TOKENS_BUDGET * 4)
    : transcript

  let response
  try {
    response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Transcript:\n\n${truncated}\n\nReturn JSON: { "memories": [...] }` },
      ],
    })
  } catch (e: any) {
    console.warn(`[ckn extract] Anthropic API call failed: ${e?.message ?? e}`)
    return []
  }

  // Extract text content
  let text = ''
  for (const block of response.content) {
    if (block.type === 'text') text += block.text
  }
  // Strip code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch?.[1]) text = fenceMatch[1]
  // Find the first { ... } block
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < 0) return []
  let parsed: { memories?: unknown[] }
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (e: any) {
    console.warn(`[ckn extract] failed to parse LLM JSON: ${e?.message ?? e}`)
    return []
  }
  if (!Array.isArray(parsed.memories)) return []

  const out: ExtractedMemory[] = []
  for (const m of parsed.memories) {
    if (!m || typeof m !== 'object') continue
    const mm = m as Record<string, any>
    const kind = String(mm.kind ?? '')
    if (!['decision', 'workflow', 'error', 'reference', 'topic', 'note'].includes(kind)) continue
    out.push({
      kind: kind as ExtractedMemory['kind'],
      slug: String(mm.slug ?? ''),
      name: String(mm.name ?? ''),
      description: String(mm.description ?? ''),
      outcome: ['success', 'failure', 'unknown'].includes(String(mm.outcome))
        ? (mm.outcome as ExtractedMemory['outcome'])
        : 'unknown',
      anchor_tags: Array.isArray(mm.anchor_tags) ? mm.anchor_tags.map(String) : [],
      mentions_files: Array.isArray(mm.mentions_files) ? mm.mentions_files.map(String) : [],
      mentions_tools: Array.isArray(mm.mentions_tools) ? mm.mentions_tools.map(String) : [],
      body: String(mm.body ?? ''),
    })
  }
  return out
}

// ── profile facet extraction (perception of the human) ──────────────────────
//
// ProfileFacetCandidate, FACET_SYSTEM_PROMPT, and parseFacetResponse live in
// the side-effect-free ./_profile-facets.js library so tests can import the
// pure parser without firing this hook (which calls main() at module load).

/** Mirrors callLlm() (ckn-extract.ts callLlm): same client/model, same
 * input-budget truncation, graceful empty on no key. */
async function callLlmFacets(transcript: string): Promise<ProfileFacetCandidate[]> {
  const apiKey = await resolveAnthropicKey()
  if (!apiKey) return []
  const truncated = transcript.length > MAX_INPUT_TOKENS_BUDGET * 4
    ? transcript.slice(-MAX_INPUT_TOKENS_BUDGET * 4)
    : transcript
  try {
    const client = new Anthropic({ apiKey })
    const response = await client.messages.create({
      model: HAIKU_MODEL, max_tokens: MAX_OUTPUT_TOKENS, system: FACET_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Transcript:\n\n${truncated}\n\nReturn JSON: { "facets": [...] }` }],
    })
    const text = response.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
    return parseFacetResponse(text)
  } catch { return [] }
}

/** Best-effort POST to the running server; no-op if the server is down (Path A stays headless-safe). */
async function postFacets(sessionId: string, candidates: ProfileFacetCandidate[]): Promise<void> {
  if (candidates.length === 0) return
  try {
    await fetch(`${SERVER_URL}/api/profile/observe`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, candidates }),
    })
  } catch { /* server down — facets are skipped this run; next session re-observes */ }
}

const NARRATIVE_HASH_FILE = path.join(os.homedir(), '.config', 'ckn', 'profile-narrative.hash')

/**
 * Compose a 2-4 sentence "about the human" narrative from the active facets via Haiku
 * (Path A). Throttled: re-synthesizes only when the active-facet set changed materially
 * since last run (hash of sorted id:stance:confidence). No API key → Path B (/cortex-snapshot)
 * composes it instead. Best-effort: any failure (server down, no facets) is a silent no-op.
 */
async function synthesizeNarrative(): Promise<void> {
  const apiKey = await resolveAnthropicKey()
  if (!apiKey) return  // Path B composes the narrative via /cortex-snapshot instead
  let profile: { facets: any[] }
  try { profile = await fetch(`${SERVER_URL}/api/profile?min=0.6`).then((r) => r.json()) } catch { return }
  if (!profile?.facets?.length) return
  const sig = profile.facets.map((f) => `${f.id}:${f.stance}:${f.confidence.toFixed(2)}`).sort().join('|')
  const hash = createHash('sha256').update(sig).digest('hex')
  try { if (fsSync.readFileSync(NARRATIVE_HASH_FILE, 'utf8').trim() === hash) return } catch { /* no prior */ }
  const facetLines = profile.facets.map((f) => `- [${f.dimension}] ${f.statement} (confidence ${f.confidence})`).join('\n')
  try {
    const client = new Anthropic({ apiKey })
    const r = await client.messages.create({ model: HAIKU_MODEL, max_tokens: 400,
      system: 'Compose a 2-4 sentence third-person description of this person from the perception facets. Descriptive, warm, not a rulebook. No preamble.',
      messages: [{ role: 'user', content: facetLines }] })
    const text = r.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim()
    if (!text) return
    await fetch(`${SERVER_URL}/api/profile/narrative`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
    fsSync.mkdirSync(path.dirname(NARRATIVE_HASH_FILE), { recursive: true })
    fsSync.writeFileSync(NARRATIVE_HASH_FILE, hash)
  } catch { /* best-effort */ }
}

// ── session entry update ───────────────────────────────────────────────────

interface SessionStats {
  endedAt: string
  turnsCount: number
  filesTouchedCount: number
  toolsUsedCount: number
  finalState: 'complete' | 'abandoned'
}

const computeSessionStats = (turns: Turn[]): SessionStats => {
  const files = new Set<string>()
  const tools = new Set<string>()
  const filePathRegex =
    /(?:^|[\s"'`(\[])((?:\.{0,2}\/|[a-zA-Z]:[\\/]|~\/)[^\s"'`)\]]+\.(?:ts|tsx|js|jsx|json|md|py|sh|sql|yaml|yml|toml|css|html))/g
  for (const t of turns) {
    if (t.toolName) tools.add(t.toolName)
    if (t.toolArgs) {
      let m: RegExpExecArray | null
      while ((m = filePathRegex.exec(t.toolArgs)) !== null) files.add(m[1]!)
    }
  }
  // Final state heuristic: if the LAST few turns include errors or the
  // user hasn't replied since the last error, treat as 'abandoned'.
  // Otherwise 'complete'.
  const tail = turns.slice(-6)
  const hasUnresolvedError = tail.some((t) => t.role === 'tool_result' && t.isError)
  const finalState: 'complete' | 'abandoned' = hasUnresolvedError ? 'abandoned' : 'complete'
  return {
    endedAt: new Date().toISOString(),
    turnsCount: turns.length,
    filesTouchedCount: files.size,
    toolsUsedCount: tools.size,
    finalState,
  }
}

interface ExistingSessionFm {
  name?: string
  description?: string
  authorship?: string
  startedAt?: string
  body: string
}

/**
 * Read the latest `custom-title` event from a JSONL. The custom-title
 * event type is Claude Code's native session-naming mechanism — set
 * via `claude -n` at launch or by /cortex-rename mid-session (which appends a
 * matching event). The latest occurrence wins. Returns null when the
 * file is missing or has no custom-title events.
 */
const readCustomTitle = (jsonlPath: string): string | null => {
  let raw: string
  try {
    raw = fsSync.readFileSync(jsonlPath, 'utf-8')
  } catch {
    return null
  }
  let title: string | null = null
  for (const ln of raw.split('\n')) {
    if (!ln.includes('"custom-title"')) continue
    try {
      const evt = JSON.parse(ln) as { type?: string; customTitle?: string }
      if (evt.type === 'custom-title' && typeof evt.customTitle === 'string') {
        title = evt.customTitle
      }
    } catch {}
  }
  return title
}

const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

const parseExistingSession = (raw: string): ExistingSessionFm => {
  const m = raw.match(FRONTMATTER_FENCE)
  if (!m) return { body: raw }
  const out: ExistingSessionFm = { body: raw.slice(m[0].length).trimStart() }
  for (const ln of (m[1] ?? '').split('\n')) {
    const idx = ln.indexOf(':')
    if (idx < 0) continue
    const key = ln.slice(0, idx).trim()
    let val = ln.slice(idx + 1).trim()
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
    }
    switch (key) {
      case 'name': out.name = val; break
      case 'description': out.description = val; break
      case 'authorship': out.authorship = val; break
      case 'started_at': out.startedAt = val; break
    }
  }
  return out
}

/**
 * Update the session entry's .md file at SessionEnd. The topic name
 * comes from Claude Code's native `custom-title` JSONL event (set via
 * `claude -n` at launch or /cortex-rename mid-session). Falls back to the
 * extractor's derivedName when no custom-title is present, then to a
 * path-based placeholder. No prompt_state machine — naming is a
 * user-driven action via /cortex-rename, not a hook-triggered ceremony.
 */
const updateSessionEntry = async (
  cwd: string,
  sessionId: string,
  stats: SessionStats,
  derivedName: string | null,
  derivedDescription: string | null,
  filesTouched: string[],
  toolsUsed: string[],
  authorship: string,
  agentId: string,
): Promise<void> => {
  const encProj = encodeProjectDir(cwd)
  const memDir = path.join(os.homedir(), '.claude', 'projects', encProj, 'memory')
  const file = path.join(memDir, `session-${sessionId}.md`)
  // Transcript READ path resolves to the dir that actually holds <sid>.jsonl
  // (subdir-cwd safe); encProj above stays the storage key for memDir/id/scope.
  const jsonlPath = path.join(projectDirForSession(sessionId, cwd), `${sessionId}.jsonl`)

  let existing: ExistingSessionFm = { body: '' }
  if (fsSync.existsSync(file)) {
    existing = parseExistingSession(await fsp.readFile(file, 'utf-8'))
  }

  const customTitle = readCustomTitle(jsonlPath)
  const name =
    customTitle ??
    derivedName ??
    existing.name ??
    `${path.basename(cwd)}/${sessionId.slice(0, 8)}`

  const description =
    derivedDescription || existing.description ||
    `Session ended ${stats.endedAt} — ${stats.turnsCount} turns, ${stats.filesTouchedCount} files, ${stats.toolsUsedCount} tools`

  const id = `session:${encProj}/${sessionId}`
  const startedAt = existing.startedAt ?? stats.endedAt

  const fmLines = [
    '---',
    `id: ${id}`,
    `name: ${yamlString(name)}`,
    `description: ${yamlString(description)}`,
    `type: session`,
    `scope: ${yamlString(`session:${encProj}/${sessionId}`)}`,
    `authorship: ${authorship}`,
    `session_id: ${sessionId}`,
    `started_at: ${yamlString(startedAt)}`,
    `ended_at: ${yamlString(stats.endedAt)}`,
    `final_state: ${stats.finalState}`,
    `outcome: ${stats.finalState === 'complete' ? 'success' : 'unknown'}`,
    `turns_count: ${stats.turnsCount}`,
    `files_touched_count: ${stats.filesTouchedCount}`,
    `tools_used_count: ${stats.toolsUsedCount}`,
    `machine: ${yamlString(getMachineId())}`,
  ]
  if (agentId) fmLines.push(`agent_id: ${agentId}`)
  if (filesTouched.length > 0) fmLines.push(`mentions_files: ${yamlList(filesTouched.slice(0, 50))}`)
  if (toolsUsed.length > 0) fmLines.push(`mentions_tools: ${yamlList(toolsUsed)}`)
  fmLines.push('---', '')

  const body =
    existing.body ||
    `# ${name}\n\nSession entry — see ${stats.turnsCount} turns of activity in the linked transcript. Memories extracted from this session link here via OCCURRED_IN.`

  await fsp.mkdir(memDir, { recursive: true })
  await fsp.writeFile(file, fmLines.join('\n') + body + '\n', 'utf-8')
}

// ── contradiction detection (Phase 6) ──────────────────────────────────────

/**
 * Heuristic detector. A new memory CONTRADICTS an old one when:
 *   1. They have high cosine similarity (≥ 0.65) — same topic
 *   2. They have OPPOSITE outcomes (success vs failure)
 *   3. They share at least one file or tool reference (same context)
 *
 * Pure deterministic. No extra LLM call — runs whenever embeddings are
 * available. Returns the list of OLD memory ids the new one contradicts;
 * those go into the new memory's `contradicts:` frontmatter so the sync
 * pipeline materializes the typed CONTRADICTS edge.
 *
 * The directionality is "new contradicts old" — the new memory points
 * at the old one. We don't modify the old memory; promotion / curation
 * surfaces the conflict for human resolution.
 */
const detectContradictions = async (
  newMemory: ExtractedMemory,
  evidence: AnchorEvidence,
  newMentionsFiles: string[],
  newMentionsTools: string[],
): Promise<string[]> => {
  // Skip when embeddings are off — the contradiction model relies on
  // semantic similarity. This is a graceful degradation, not a failure.
  let getEmbeddingMode: () => string
  let embedText: (text: string) => Promise<Float32Array | null>
  let searchSimilar: (q: Float32Array, k: number, min: number) => Promise<{ id: string; score: number }[]>
  try {
    const mod1 = await import('../server/embeddings.js')
    const mod2 = await import('../server/embeddingStore.js')
    getEmbeddingMode = mod1.getEmbeddingMode
    embedText = mod1.embedText
    searchSimilar = mod2.searchSimilar
  } catch {
    return []
  }
  if (getEmbeddingMode() === 'off') return []

  // Embed the new memory text — same shape we'll use when sync stores
  // it later, so the cosine comparison is consistent.
  const text = [newMemory.name, newMemory.description, newMemory.body, evidence.evidence]
    .filter(Boolean)
    .join('\n\n')
  const vec = await embedText(text)
  if (!vec) return []

  // Pull top-15 similar existing entries. Use a high min-cosine cutoff
  // (0.5) — contradiction detection wants close cousins, not loosely
  // related notes. searchSimilar reads the lock-free embeddings sidecar,
  // so this step never touches the graph DB.
  const similar = await searchSimilar(vec, 15, 0.5)
  if (similar.length === 0) return []
  const similarIds = similar.map((s) => s.id)

  // The graph hydration + heuristic now lives server-side at
  // /api/graph/contradictions. ckn-extract is the SessionEnd hook; the
  // server is almost always running (and owns the single SQLite writer),
  // so opening the DB directly here contends every time — which silently
  // disabled contradiction detection in normal use. Go through the API
  // when the server is up; direct-open only when it's not.
  const { isServerUp } = await import('./_graph-guard.js')
  if (await isServerUp()) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 5_000)
      const res = await fetch(`${SERVER_URL}/api/graph/contradictions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          similarIds,
          outcome: newMemory.outcome,
          mentionsFiles: newMentionsFiles,
          mentionsTools: newMentionsTools,
        }),
        signal: ctrl.signal,
      })
      clearTimeout(t)
      if (res.ok) {
        const data = (await res.json()) as { contradicts?: string[] }
        return data.contradicts ?? []
      }
      // Server up but endpoint failed — do NOT direct-open (would
      // contend with the server's writer). Skip contradiction detection
      // this run; the memory is still written, just without CONTRADICTS edges.
      console.warn('[ckn extract] /api/graph/contradictions failed; skipping contradiction detection this run')
      return []
    } catch {
      console.warn('[ckn extract] contradiction API unreachable; skipping this run')
      return []
    }
  }

  // No server bound — safe to read the graph DB directly via the shared module.
  const { findContradictions } = await import('../server/graph/contradictions.js')
  return findContradictions({
    similarIds,
    outcome: newMemory.outcome,
    mentionsFiles: newMentionsFiles,
    mentionsTools: newMentionsTools,
  })
}

// ── memory writing ─────────────────────────────────────────────────────────

const yamlString = (raw: string): string => {
  const s = String(raw ?? '')
  if (!s) return '""'
  if (/^[\w/.\-+]+$/.test(s)) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

const yamlList = (items: string[]): string =>
  items.length === 0 ? '[]' : `[${items.map(yamlString).join(', ')}]`

const encodeProjectDir = (projectDir: string): string =>
  projectDir.replace(/[/\\:]/g, '-')

const writeMemoryFile = async (
  m: ExtractedMemory,
  evidence: AnchorEvidence,
  context: {
    projectDir: string
    sessionId: string
    authorship: string
    agentId: string
    linearTicket: string
    taskBranch: string
  },
  contradicts: string[] = [],
): Promise<string> => {
  const encProj = encodeProjectDir(context.projectDir)
  const memDir = path.join(os.homedir(), '.claude', 'projects', encProj, 'memory')
  // Slug fallback if LLM didn't produce one
  const slug = (m.slug || m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 60) || 'memory'
  const file = path.join(memDir, `${m.kind}-${slug}.md`)

  // Merge LLM-listed mentions with verbatim-extracted mentions. Verbatim wins.
  const mentionsFiles = Array.from(new Set([...(m.mentions_files ?? []), ...evidence.filePaths]))
  const mentionsTools = Array.from(new Set([...(m.mentions_tools ?? []), ...evidence.toolNames]))

  const id = `${encProj}/${m.kind}-${slug}`

  const fmLines = [
    '---',
    `id: ${id}`,
    `name: ${yamlString(m.name)}`,
    `description: ${yamlString(m.description)}`,
    `type: ${m.kind}`,
    `authorship: ${context.authorship}`,
    `outcome: ${m.outcome}`,
    `outcome_text: ${yamlString(evidence.outcomeText)}`,
    `session_id: ${context.sessionId}`,
    `machine: ${yamlString(getMachineId())}`,
  ]
  if (context.agentId) fmLines.push(`agent_id: ${context.agentId}`)
  if (context.linearTicket) fmLines.push(`linear_ticket: ${yamlString(context.linearTicket)}`)
  if (context.taskBranch) fmLines.push(`task_branch: ${yamlString(context.taskBranch)}`)
  if (mentionsFiles.length > 0) fmLines.push(`mentions_files: ${yamlList(mentionsFiles)}`)
  if (mentionsTools.length > 0) fmLines.push(`mentions_tools: ${yamlList(mentionsTools)}`)
  // Phase 6: contradictions detected against the existing graph at
  // extraction time. Sync materializes these into typed CONTRADICTS
  // edges (new memory → old memory).
  if (contradicts.length > 0) fmLines.push(`contradicts: ${yamlList(contradicts)}`)
  fmLines.push(`occurred_in: ${yamlString(`${encProj}/${context.sessionId}`)}`)
  fmLines.push('---')
  fmLines.push('')

  // Body: LLM summary (categorization), then verbatim evidence section
  // (the actual content). Verbatim wins on a re-read — the LLM body is
  // a *label* on top of the transcript-anchored truth.
  const body = [
    `# ${m.name}`,
    '',
    m.body || m.description,
    '',
    '## Verbatim evidence',
    '',
    'The following is copied verbatim from the session transcript. The Cortex extraction layer never paraphrases tool outputs, error messages, or outcome text — only the categorization above is LLM-generated.',
    '',
    evidence.evidence,
    '',
  ].join('\n')

  await fsp.mkdir(memDir, { recursive: true })
  await fsp.writeFile(file, fmLines.join('\n') + body, 'utf-8')
  return file
}

// ── main extraction pipeline ───────────────────────────────────────────────

interface ExtractContext {
  projectDir: string
  sessionId: string
  transcriptPath: string
  authorship: string
  agentId: string
  /** Phase 7 worker-mode provenance — empty strings on solo workstations. */
  linearTicket: string
  taskBranch: string
}

const extractSession = async (ctx: ExtractContext): Promise<{
  written: string[]
  skipped: string
}> => {
  const turns = parseTranscript(ctx.transcriptPath)

  // Always update the session entry on SessionEnd, even when the
  // transcript is too short for memory extraction. The session itself
  // still graduated to 'complete' / 'abandoned' and other queries care
  // about that state.
  const stats = computeSessionStats(turns)
  // Aggregate every file/tool we saw across the session (not just
  // anchor turns). Updating session.mentions_files lets the OCCURRED_IN
  // traversal also surface what touched what.
  const sessionFiles = new Set<string>()
  const sessionTools = new Set<string>()
  const filePathRegex =
    /(?:^|[\s"'`(\[])((?:\.{0,2}\/|[a-zA-Z]:[\\/]|~\/)[^\s"'`)\]]+\.(?:ts|tsx|js|jsx|json|md|py|sh|sql|yaml|yml|toml|css|html))/g
  for (const t of turns) {
    if (t.toolName) sessionTools.add(t.toolName)
    if (t.toolArgs) {
      let m: RegExpExecArray | null
      while ((m = filePathRegex.exec(t.toolArgs)) !== null) sessionFiles.add(m[1]!)
    }
  }

  if (turns.length < MIN_TURNS_TO_EXTRACT) {
    // Still update session entry so it graduates from 'pending' state
    await updateSessionEntry(
      ctx.projectDir, ctx.sessionId, stats,
      null, null,
      Array.from(sessionFiles), Array.from(sessionTools),
      ctx.authorship, ctx.agentId,
    )
    return { written: [], skipped: `transcript has only ${turns.length} turns — below minimum` }
  }

  const turnsByTag = new Map(turns.map((t) => [t.tag, t]))
  const compact = renderTranscriptForLlm(turns)
  const memories = await callLlm(compact)

  // Profile perception (best-effort): extract facet candidates and POST them
  // to the server. No-op without an API key / running server (headless-safe).
  // Always TRACKS — facets accrue in the background regardless of CKN_PROFILE,
  // which gates only whether the profile is SURFACED into a session (so a
  // profile is already populated the moment a user opts in).
  const facetCandidates = await callLlmFacets(compact)
  await postFacets(ctx.sessionId, facetCandidates)
  await synthesizeNarrative()

  // Derive a session title + description from the LLM output if it
  // produced any memories — pick the most prominent decision/workflow
  // and use its name + description as the session label. Auto_named
  // sessions get this; user-named sessions are preserved.
  let derivedName: string | null = null
  let derivedDescription: string | null = null
  if (memories.length > 0) {
    const ranked = [...memories].sort((a, b) => {
      const order = ['decision', 'workflow', 'topic', 'reference', 'error', 'note']
      return order.indexOf(a.kind) - order.indexOf(b.kind)
    })
    derivedName = ranked[0]?.name?.slice(0, 80) ?? null
    derivedDescription = ranked[0]?.description ?? null
  }

  // Update the session entry regardless of memory count.
  await updateSessionEntry(
    ctx.projectDir, ctx.sessionId, stats,
    derivedName, derivedDescription,
    Array.from(sessionFiles), Array.from(sessionTools),
    ctx.authorship, ctx.agentId,
  )

  if (memories.length === 0) {
    return { written: [], skipped: 'no memories returned (no API key or LLM judged session not memorable)' }
  }

  const written: string[] = []
  for (const m of memories) {
    const evidence = collectAnchorEvidence(m.anchor_tags, turnsByTag)
    // Merge LLM-listed mentions with verbatim-extracted mentions so the
    // contradiction detector has the full topic signal. Same merge
    // logic as writeMemoryFile, hoisted so we don't compute twice.
    const mFiles = Array.from(new Set([...(m.mentions_files ?? []), ...evidence.filePaths]))
    const mTools = Array.from(new Set([...(m.mentions_tools ?? []), ...evidence.toolNames]))
    let contradicts: string[] = []
    try {
      contradicts = await detectContradictions(m, evidence, mFiles, mTools)
      if (contradicts.length > 0) {
        console.log(
          `[ckn extract] memory '${m.slug}' contradicts ${contradicts.length} prior — ${contradicts.slice(0, 3).join(', ')}${contradicts.length > 3 ? '…' : ''}`,
        )
      }
    } catch (e: any) {
      // Detection is an enhancement layer; failure here doesn't block
      // the memory from being written without the contradicts edge.
      console.warn(`[ckn extract] contradiction check failed for '${m.slug}': ${e?.message ?? e}`)
    }
    try {
      const f = await writeMemoryFile(m, evidence, ctx, contradicts)
      written.push(f)
    } catch (e: any) {
      console.warn(`[ckn extract] failed to write memory '${m.slug}': ${e?.message ?? e}`)
    }
  }

  // Trigger a graph sync so the extractions show up in recall ASAP. The
  // sync script handles its own dual-path (server-or-direct).
  try {
    const tsx = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx')
    const script = path.join(__dirname, 'ckn-sync.ts')
    const { spawn } = await import('node:child_process')
    const child = spawn(tsx, [script], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    // best-effort
  }

  return { written, skipped: '' }
}

// ── entry points ──────────────────────────────────────────────────────────

const inferAuthorship = (): { authorship: string; agentId: string } => {
  const agentId = process.env.CKN_AGENT_ID ?? ''
  const override = process.env.CKN_AUTHORSHIP
  if (override) return { authorship: override, agentId }
  if (agentId) return { authorship: 'agent', agentId }
  return { authorship: 'auto-extracted', agentId: '' }
}

/**
 * Phase 7: extra worker-mode provenance fields. Read from env once
 * per process and woven into every memory/session entry the script
 * writes. Empty strings when not set — the orchestrator (Phase 9)
 * will populate these per-task; on solo dev workstations they stay
 * empty and the frontmatter just omits them.
 */
const inferWorkerProvenance = (): { linearTicket: string; taskBranch: string } => ({
  linearTicket: process.env.CKN_LINEAR_TICKET ?? '',
  taskBranch: process.env.CKN_TASK_BRANCH ?? '',
})

const hookMode = async (): Promise<void> => {
  const raw = await readStdin()
  let input: HookInput = {}
  try {
    input = JSON.parse(raw) as HookInput
  } catch {
    return
  }
  const sessionId = input.session_id
  const cwd = input.cwd ?? process.cwd()
  const transcriptPath = input.transcript_path

  // Sign off on the session bus (best-effort, API-only). Sign-off is a
  // presence event — if the server is down we skip it; the stale-timeout
  // (60 min) will mark the session dead anyway.
  try {
    const { isServerUp } = await import('./_graph-guard.js')
    if (sessionId && (await isServerUp())) {
      await fetch(`${SERVER_URL}/api/bus/signoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {})
    }
  } catch {
    /* never block extraction on bus sign-off */
  }

  if (!sessionId || !transcriptPath) return

  const { authorship, agentId } = inferAuthorship()
  const { linearTicket, taskBranch } = inferWorkerProvenance()
  const ctx: ExtractContext = {
    projectDir: cwd,
    sessionId,
    transcriptPath,
    authorship,
    agentId,
    linearTicket,
    taskBranch,
  }
  const result = await extractSession(ctx)
  if (result.written.length > 0) {
    console.log(`[ckn extract] wrote ${result.written.length} memories from session ${sessionId.slice(0, 8)}`)
  } else if (result.skipped) {
    console.log(`[ckn extract] session ${sessionId.slice(0, 8)} skipped — ${result.skipped}`)
  }
}

const findRecentTranscripts = async (limit: number): Promise<{ projectDir: string; sessionId: string; path: string }[]> => {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  const found: { projectDir: string; sessionId: string; path: string; mtime: number }[] = []
  let projects: string[]
  try {
    projects = await fsp.readdir(projectsRoot)
  } catch {
    return []
  }
  for (const proj of projects) {
    const dir = path.join(projectsRoot, proj)
    let entries: string[]
    try {
      entries = await fsp.readdir(dir)
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const full = path.join(dir, f)
      try {
        const stat = await fsp.stat(full)
        // Decode the project encoding back to a path-like for context
        const projectDir = '/' + proj.replace(/^-/, '').replace(/-/g, '/')
        const sessionId = path.basename(f, '.jsonl')
        found.push({ projectDir, sessionId, path: full, mtime: stat.mtimeMs })
      } catch {}
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found.slice(0, limit).map(({ projectDir, sessionId, path: p }) => ({ projectDir, sessionId, path: p }))
}

const backfillMode = async (limit: number): Promise<void> => {
  console.log(`[ckn extract] backfill — processing last ${limit} sessions`)
  const sessions = await findRecentTranscripts(limit)
  console.log(`[ckn extract] found ${sessions.length} sessions to process`)
  const { authorship, agentId } = inferAuthorship()
  const { linearTicket, taskBranch } = inferWorkerProvenance()
  for (const s of sessions) {
    const ctx: ExtractContext = {
      projectDir: s.projectDir,
      sessionId: s.sessionId,
      transcriptPath: s.path,
      authorship,
      agentId,
      linearTicket,
      taskBranch,
    }
    try {
      const result = await extractSession(ctx)
      const where = `${path.basename(path.dirname(s.path))}/${s.sessionId.slice(0, 8)}`
      if (result.written.length > 0) {
        console.log(`  ✓ ${where} — ${result.written.length} memories`)
      } else if (result.skipped) {
        console.log(`  · ${where} — skipped (${result.skipped})`)
      }
    } catch (e: any) {
      console.warn(`  ✗ ${s.sessionId.slice(0, 8)} — ${e?.message ?? e}`)
    }
  }
  console.log('[ckn extract] backfill done')
}

const sessionMode = async (projectDir: string, sessionId: string): Promise<void> => {
  const transcriptPath = path.join(projectDirForSession(sessionId, projectDir), `${sessionId}.jsonl`)
  if (!fsSync.existsSync(transcriptPath)) {
    console.error(`[ckn extract] no transcript at ${transcriptPath}`)
    process.exit(1)
  }
  const { authorship, agentId } = inferAuthorship()
  const { linearTicket, taskBranch } = inferWorkerProvenance()
  const result = await extractSession({
    projectDir,
    sessionId,
    transcriptPath,
    authorship,
    agentId,
    linearTicket,
    taskBranch,
  })
  console.log(`[ckn extract] wrote ${result.written.length} memories from ${sessionId.slice(0, 8)}`)
  if (result.skipped) console.log(`  skipped reason: ${result.skipped}`)
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  if (args[0] === '--backfill') {
    const limit = Number(args[1] ?? '20')
    await backfillMode(Number.isFinite(limit) && limit > 0 ? limit : 20)
    return
  }
  if (args[0] === '--session') {
    const projectDir = args[1]
    const sessionId = args[2]
    if (!projectDir || !sessionId) {
      console.error('usage: ckn-extract.ts --session <projectDir> <sessionId>')
      process.exit(1)
    }
    await sessionMode(projectDir, sessionId)
    return
  }
  await hookMode()
}

main().catch((e) => {
  console.error('[ckn extract] fatal:', e?.message ?? e)
  process.exit(1)
})
