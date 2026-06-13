/**
 * Aware-cache: a file the PreToolUse hook reads to decide whether to
 * round-trip to the API. The cache lists every tool name the graph has
 * relevant knowledge for. If a tool isn't in the cache, the hook exits in
 * microseconds without touching the network.
 *
 * Two sources feed the cache:
 *   1. shared / pattern memories (team-published knowledge + fail→success
 *      traces) — surface "another user knows X about this tool".
 *   2. the user's OWN native-scope operational memories (scope `user` or
 *      `project:*`) that describe how to correctly operate a tool or an
 *      external system. A memory about SSHing to the `-claude` host, or the
 *      `PLANE_API_KEY` vs `PLANE_API_TOKEN` split, names a *system* (ssh,
 *      plane) more often than the literal CC tool. We map those system
 *      keywords back to the tool that invokes them (ssh/docker/git/... →
 *      Bash; an `mcp__server__*` token → itself) so the PreToolUse hook can
 *      gate on the actual `tool_name` it receives.
 *
 * Broadening the cache to common tools like Bash is affordable because the
 * hook only does the (network) lookup on the FIRST use of a tool/target per
 * session — see bin/_session-state.ts.
 *
 * Refreshed by the server on every `graph:sync` event. Has a TTL so
 * out-of-band updates (other clients, manual graph edits) eventually get
 * picked up even without a sync event.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { all } from './graph/db.js'

const CACHE_PATH = path.join(os.homedir(), '.local', 'state', 'ckn', 'aware-cache.json')

export interface AwareCache {
  /** Tool names with non-empty graph hits. Lower-case for case-insensitive match. */
  tools: string[]
  /** Unix ms when this cache was generated. */
  generatedAt: number
}

/** TTL — if the cache is older than this, hooks should treat it as stale. */
export const AWARE_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * Shell/system tokens that, when an operational memory mentions them, mean
 * the relevant Claude Code tool is `Bash` (the catch-all the user runs them
 * through). Keeps the cache keyed on the `tool_name` the PreToolUse hook
 * actually receives, not the system name the memory happens to use.
 */
const SYSTEM_KEYWORDS = new Set([
  'ssh', 'scp', 'rsync', 'docker', 'kubectl', 'systemctl', 'systemd',
  'curl', 'wget', 'git', 'npm', 'npx', 'pnpm', 'yarn', 'psql', 'sudo',
  'bash', 'shell', 'cli', 'bao-run', 'openbao', 'jq', 'gh',
])

/**
 * Extract the tool tokens a chunk of memory text implies. Returns lower-cased
 * tool names suitable for cache membership.
 */
const extractToolTokens = (text: string): string[] => {
  const out: string[] = []
  // Explicit MCP tool/server tokens — already specific.
  for (const m of text.match(/\bmcp__\w+(?:__\w+)?\b/g) ?? []) out.push(m.toLowerCase())
  // CamelCase tokens that look like core CC tool names (Bash, Read, Edit…).
  for (const m of text.match(/\b[A-Z][A-Za-z]{2,}\b/g) ?? []) out.push(m.toLowerCase())
  // System keywords → Bash.
  for (const m of text.toLowerCase().match(/\b[a-z][a-z-]{1,}\b/g) ?? []) {
    if (SYSTEM_KEYWORDS.has(m)) out.push('bash')
  }
  return out
}

/**
 * Walk the graph for tool names referenced by (1) shared/pattern memories and
 * (2) the user's native-scope operational memories, and dump the unique set
 * to the cache file. Cheap — pulls names + descriptions only (the deliberate,
 * high-signal fields), typically a few hundred entries.
 */
export const refreshAwareCache = async (): Promise<AwareCache> => {
  const tools = new Set<string>()

  // (1) shared + pattern: scan name + description.
  const shared = all<{ name: string; description: string }>(
    `SELECT name AS name, description AS description FROM entries ` +
      `WHERE scope LIKE 'shared:%' ESCAPE '\\' OR kind = 'pattern' ` +
      `LIMIT 500`,
  )
  for (const r of shared) {
    for (const t of extractToolTokens(`${r.name} ${r.description}`)) tools.add(t)
  }

  // (2) native operational memories (scope user / project:*). Only the
  // memory-ish kinds — not files, tools, sessions, or bulk vault imports —
  // since those aren't deliberate operational notes.
  const native = all<{ name: string; description: string }>(
    `SELECT name AS name, description AS description FROM entries ` +
      `WHERE (scope = 'user' OR scope LIKE 'project%' ESCAPE '\\') ` +
      `  AND kind IN ('memory','decision','reference','workflow','error','topic','note') ` +
      `LIMIT 2000`,
  )
  for (const r of native) {
    for (const t of extractToolTokens(`${r.name} ${r.description ?? ''}`)) tools.add(t)
  }

  const cache: AwareCache = {
    tools: Array.from(tools).sort(),
    generatedAt: Date.now(),
  }
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true })
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache), 'utf-8')
  return cache
}

/**
 * Hook-side cache lookup. Returns the parsed cache if present + fresh.
 * On miss the caller falls back to the API or skips entirely.
 */
export const readAwareCache = async (): Promise<AwareCache | null> => {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf-8')
    const cache = JSON.parse(raw) as AwareCache
    if (!cache.tools || typeof cache.generatedAt !== 'number') return null
    return cache
  } catch {
    return null
  }
}
