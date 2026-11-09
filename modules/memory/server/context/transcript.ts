/**
 * Claude Code session transcripts (JSONL) into dialogue blocks.
 *
 * The context store keeps what a conversation SAID, not what its tools did
 * (private mind design, D2 and section 4.2.1): human and assistant text, a
 * short note for each tool failure, and the session's metadata. Thinking, tool
 * inputs and outputs, attachments (hook context lives there) and injected lines
 * (task notifications, peer messages, compact summaries) are dropped.
 *
 * Pure: lines in, events out. The caller keeps `ParseState` between calls,
 * because a capture reads a growing file in pieces and one assistant message is
 * spread over several lines (one per content block, sharing `message.id`).
 */

/** `operator` and `peer` come from dialogue feeds: a person on a chat bot, another session on the bus. */
export type Speaker = 'user' | 'assistant' | 'tool-note' | 'operator' | 'peer' | 'member'

/** One piece of dialogue. Parts with the same `key` are one block, in order. */
export type BlockPart = {
  /** The block's identity in its session: the message id for assistant text, else the line uuid. */
  key: string
  /** This line's uuid: a part is applied once, however often its line is read. */
  uuid: string
  speaker: Speaker
  at: number
  text: string
  /** The first block after a compaction starts a new stretch. */
  boundary?: boolean
  /** Who spoke, when a feed names them. */
  party?: string
}

export type SessionMeta = {
  session?: string
  cwd?: string
  branch?: string
  version?: string
  title?: string
  agent?: string
  entrypoint?: string
  sidechain?: boolean
}

export type ParseState = {
  /** Tool calls seen and not yet resolved: id to a short description. Bounded. */
  tools: Record<string, string>
  /** A compaction happened since the last block. */
  boundary: boolean
}

export const newState = (): ParseState => ({ tools: {}, boundary: false })

const TOOLS_KEPT = 200
const NOTE_MAX = 200

/** User strings that are Claude Code's own plumbing, not something a person typed. */
const PLUMBING = /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|system-reminder|task-notification|user-prompt-submit-hook)\b/

const firstLine = (s: string): string => s.split('\n').find((l) => l.trim())?.trim() ?? ''
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const at = (d: { timestamp?: string }): number => (d.timestamp ? Date.parse(d.timestamp) || 0 : 0)

/** A slash command as the person typed it: `/name args`. */
const slashCommand = (s: string): string | undefined => {
  const name = s.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim()
  if (!name) return undefined
  const args = s.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

/** A `!` shell line as the person typed it. Its output is tool output and is dropped. */
const bangCommand = (s: string): string | undefined => {
  const cmd = s.match(/<bash-input>([\s\S]*?)<\/bash-input>/)?.[1]?.trim()
  return cmd ? `! ${cmd}` : undefined
}

const describeTool = (name: string, input: Record<string, unknown> | undefined): string => {
  const target = (input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? '') as string
  return target ? `${name} ${clip(firstLine(String(target)), 80)}` : name
}

const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n')
  return ''
}

/** A markdown file the session wrote: where its memory anchors, if it is one. */
export type FileWrite = { file: string; at: number; uuid: string }

export type ParsedLine = { meta?: SessionMeta; parts: BlockPart[]; writes?: FileWrite[] }

/** Files a shell command writes with a heredoc, a redirect or tee. */
const shellWrites = (cmd: string): string[] =>
  [...cmd.matchAll(/(?:>>?|\btee(?:\s+-a)?)\s+['"]?([^\s'";|&<>]+\.md)\b/g)].map((m) => m[1]!)

/**
 * One transcript line. Unknown or malformed lines yield nothing: the format
 * belongs to Claude Code and grows new line types, and capture must not stop
 * on one it has not seen.
 */
export const parseLine = (line: string, state: ParseState): ParsedLine => {
  let d: Record<string, any>
  try {
    d = JSON.parse(line)
  } catch {
    return { parts: [] }
  }
  if (!d || typeof d !== 'object') return { parts: [] }

  const meta: SessionMeta = {}
  if (typeof d.sessionId === 'string') meta.session = d.sessionId
  if (typeof d.cwd === 'string') meta.cwd = d.cwd
  if (typeof d.gitBranch === 'string') meta.branch = d.gitBranch
  if (typeof d.version === 'string') meta.version = d.version
  if (typeof d.entrypoint === 'string') meta.entrypoint = d.entrypoint
  if (d.isSidechain === true) meta.sidechain = true
  if (d.type === 'custom-title' && typeof d.customTitle === 'string') meta.title = d.customTitle
  if (d.type === 'agent-name' && typeof d.agentName === 'string') meta.agent = d.agentName
  const out: ParsedLine = { meta: Object.keys(meta).length ? meta : undefined, parts: [] }

  const part = (p: Omit<BlockPart, 'boundary'>) => {
    out.parts.push(state.boundary ? { ...p, boundary: true } : p)
    state.boundary = false
  }

  if (d.type === 'system' && d.subtype === 'compact_boundary') {
    state.boundary = true
    return out
  }

  if (d.type === 'assistant' && d.message && Array.isArray(d.message.content)) {
    const key = typeof d.message.id === 'string' ? d.message.id : d.uuid
    for (const c of d.message.content) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        part({ key, uuid: String(d.uuid ?? key), speaker: 'assistant', at: at(d), text: c.text })
      } else if (c?.type === 'tool_use' && typeof c.id === 'string') {
        state.tools[c.id] = describeTool(String(c.name ?? 'tool'), c.input)
        const name = String(c.name ?? '')
        const files =
          ['Write', 'Edit', 'MultiEdit'].includes(name) && typeof c.input?.file_path === 'string' && c.input.file_path.endsWith('.md')
            ? [c.input.file_path as string]
            : name === 'Bash' && typeof c.input?.command === 'string'
              ? shellWrites(c.input.command)
              : []
        for (const file of files) (out.writes ??= []).push({ file, at: at(d), uuid: String(d.uuid ?? c.id) })
        const ids = Object.keys(state.tools)
        if (ids.length > TOOLS_KEPT) for (const id of ids.slice(0, ids.length - TOOLS_KEPT)) delete state.tools[id]
      }
    }
    return out
  }

  if (d.type !== 'user' || !d.message) return out
  if (d.isMeta === true || d.isCompactSummary === true) return out
  const origin = d.origin?.kind
  const content = d.message.content

  if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'tool_result') {
        const tool = state.tools[c.tool_use_id] ?? 'a tool'
        delete state.tools[c.tool_use_id]
        if (c.is_error === true) {
          const err = firstLine(resultText(c.content)) || 'failed'
          part({ key: `${d.uuid}:${c.tool_use_id}`, uuid: `${d.uuid}:${c.tool_use_id}`, speaker: 'tool-note', at: at(d), text: clip(`${tool} failed: ${err}`, NOTE_MAX) })
        }
      } else if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim() && (origin === undefined || origin === 'human') && !PLUMBING.test(c.text)) {
        part({ key: String(d.uuid), uuid: String(d.uuid), speaker: 'user', at: at(d), text: c.text })
      }
    }
    return out
  }

  if (typeof content !== 'string' || !content.trim()) return out
  // Notifications, peer messages and anything else injected carry an origin other than a person.
  if (origin !== undefined && origin !== 'human') return out
  if (PLUMBING.test(content)) return out
  const text = slashCommand(content) ?? bangCommand(content) ?? (/^\s*<command-/.test(content) ? undefined : content)
  if (text) part({ key: String(d.uuid), uuid: String(d.uuid), speaker: 'user', at: at(d), text })
  return out
}
