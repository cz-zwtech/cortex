/**
 * Capability sheet compiler.
 *
 * Scans the user-scope and (optionally) project-scope `.claude/` directories
 * to build a structured markdown sheet of everything Claude has access to —
 * skills, MCP servers, allow-permissions, sub-agents.
 *
 * Emitted by the SessionStart hook as `additionalContext` so Claude knows
 * its capabilities from turn 1 of every session. Without this, Claude
 * defaults to "tell the user to run X" instead of running X itself even
 * when a skill exists for it.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'
import { getProfile, profileFacetCount, INJECT_MIN, type ProfileView } from './graph/profile.js'
import { profileEnabled } from './profileEnabled.js'
import { ancestorProjectScopes } from './graph/projectScopes.js'

const FENCE = /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/

// The onboarding prompt is ONE-TIME and user-global (cwd-independent): shown only when the
// profile is blank AND it has not been shown before. The marker lives under ~/.config/ckn
// (not per-project), so it never re-fires across cwds or machines; and any later facet
// (seeded, observed, or synced via private-mind) makes the profile non-blank, also stopping it.
const ONBOARDING_MARKER = path.join(os.homedir(), '.config', 'ckn', 'onboarding-profile.json')

// Personality profile opt-in switch (env CKN_PROFILE, default OFF). Single
// source of truth in ./profileEnabled.js; re-exported here for tests.
export { profileEnabled }

const onboardingPending = async (): Promise<boolean> => {
  if (!profileEnabled()) return false                          // profile opt-in: off ⇒ never nudge
  let count = 0
  try { count = profileFacetCount() } catch { return false }  // DB unavailable → don't nudge
  if (count > 0) return false                                  // already has a profile
  try { await fs.access(ONBOARDING_MARKER); return false } catch { return true }  // marker absent ⇒ pending
}
const markOnboardingShown = async (): Promise<void> => {
  try {
    await fs.mkdir(path.dirname(ONBOARDING_MARKER), { recursive: true })
    await fs.writeFile(ONBOARDING_MARKER, JSON.stringify({ shownAt: Date.now() }), 'utf-8')
  } catch { /* best-effort: a failed marker write at worst re-nudges next session */ }
}

interface SkillInfo {
  name: string
  description: string
  scope: 'user' | 'project'
  allowedTools?: string[]
}

interface AgentInfo {
  name: string
  description: string
  scope: 'user' | 'project'
}

interface McpInfo {
  name: string
  scope: 'user' | 'project'
  enabled: boolean
  toolPrefix: string // e.g. "mcp__databricks__"
}

interface PermissionGroup {
  scope: 'user' | 'project'
  allow: string[]
  ask: string[]
}

interface CapabilitySheetData {
  skills: SkillInfo[]
  agents: AgentInfo[]
  mcpServers: McpInfo[]
  permissions: PermissionGroup[]
  additionalDirectories: string[]
  defaultMode?: string
  /**
   * Memories relevant to the current cwd: user-scope (always relevant) plus
   * project-scope memories matched by the cwd's claude-projects encoding.
   * Sourced from the graph; lets SessionStart and PostCompact restore
   * project-aware context on top of pure capability awareness.
   */
  memories: MemoryInfo[]
  /** Pre-rendered Mission/Directives/Disposition block from
   *  ~/.config/ckn/identity.yaml + project override. Null when no
   *  identity files exist. */
  identityMarkdown: string | null
  /** The AI's evidence-grounded PERCEPTION of the human: synthesized
   *  narrative + active facets above the injection bar. NOT human-editable;
   *  it moves only via behavioral counter-evidence or an earned competing
   *  perception. Replaces the raw "observed about this user" block. */
  profile: ProfileView
  /** Interaction overrides the human has authored as `feedback` memories —
   *  surfaced (not stored anew) so Claude honors them over the perception
   *  for *how* to engage. */
  overrides: string[]
  /** True only on a first run with a blank profile (and the one-time marker not
   *  yet written): renders the `/cortex-profile-setup` onboarding nudge. */
  onboarding: boolean
  /** Personality profile opt-in (env `CKN_PROFILE`). When false, the whole
   *  "Your profile" section is omitted from the sheet (default — opt-in). */
  profileEnabled: boolean
}

interface MemoryInfo {
  id: string
  name: string
  scope: string
  kind: string
  description: string
  /** Trimmed body — full content available via /api/graph/node/:id. */
  bodyPreview: string
  syncedAt: number
  /** 0/1: feedback promoted to the hard managed CLAUDE.md block. When set, the
   * memory is excluded from the SOFT interaction-overrides list (hard now). */
  engagement?: number
}

// ── frontmatter helper ───────────────────────────────────────────────────────

function parseFrontmatter(text: string): { data: Record<string, any>; body: string } {
  const m = text.match(FENCE)
  if (!m) return { data: {}, body: text }
  let data: Record<string, any> = {}
  try { data = YAML.parse(m[1] ?? '') ?? {} } catch {}
  return { data, body: text.slice(m[0].length) }
}

const safeReadJson = async <T = unknown>(p: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8')) as T
  } catch {
    return null
  }
}

const safeReadDir = async (p: string): Promise<string[]> => {
  try {
    return await fs.readdir(p)
  } catch {
    return []
  }
}

// ── skill scanner ────────────────────────────────────────────────────────────

const readSkillsFromDir = async (
  dir: string,
  scope: 'user' | 'project',
): Promise<SkillInfo[]> => {
  const out: SkillInfo[] = []
  const entries = await safeReadDir(dir)
  for (const name of entries) {
    const skillFile = path.join(dir, name, 'SKILL.md')
    try {
      const raw = await fs.readFile(skillFile, 'utf-8')
      const { data } = parseFrontmatter(raw)
      out.push({
        name: String(data.name ?? name),
        description: String(data.description ?? ''),
        scope,
        allowedTools: Array.isArray(data['allowed-tools']) ? data['allowed-tools'].map(String) : undefined,
      })
    } catch {
      // ignore — skills are optional
    }
  }
  return out
}

// ── agent scanner ────────────────────────────────────────────────────────────

const readAgentsFromDir = async (
  dir: string,
  scope: 'user' | 'project',
): Promise<AgentInfo[]> => {
  const out: AgentInfo[] = []
  const entries = await safeReadDir(dir)
  for (const f of entries) {
    if (!f.endsWith('.md')) continue
    const full = path.join(dir, f)
    try {
      const raw = await fs.readFile(full, 'utf-8')
      const { data } = parseFrontmatter(raw)
      out.push({
        name: String(data.name ?? f.slice(0, -3)),
        description: String(data.description ?? ''),
        scope,
      })
    } catch {
      // skip
    }
  }
  return out
}

// ── MCP scanner ──────────────────────────────────────────────────────────────

const readUserMcpServers = async (home: string): Promise<McpInfo[]> => {
  // ~/.claude.json holds user-scope MCP servers under .mcpServers
  const config = await safeReadJson<any>(path.join(home, '.claude.json'))
  if (!config?.mcpServers) return []
  return Object.entries(config.mcpServers).map(([name, raw]: [string, any]) => ({
    name,
    scope: 'user' as const,
    enabled: raw?.disabled !== true,
    toolPrefix: `mcp__${name}__`,
  }))
}

const readProjectMcpServers = async (cwd: string): Promise<McpInfo[]> => {
  // <project>/.mcp.json holds project-scope MCP servers
  const config = await safeReadJson<any>(path.join(cwd, '.mcp.json'))
  if (!config?.mcpServers) return []
  return Object.entries(config.mcpServers).map(([name, raw]: [string, any]) => ({
    name,
    scope: 'project' as const,
    enabled: raw?.disabled !== true,
    toolPrefix: `mcp__${name}__`,
  }))
}

// ── permission scanner ───────────────────────────────────────────────────────

/**
 * Match permission rules whose argument might leak sensitive paths or
 * embedded credentials when injected into Claude's context (and from
 * there into Anthropic's logs). Conservative — false positives just mean
 * a `***` in the capability sheet, which is fine.
 */
const SENSITIVE_KEYWORDS = [
  '.ssh',
  '.aws',
  '.gcp',
  '.gnupg',
  '.kube',
  '.docker',
  '.netrc',
  '/private',
  '/secrets',
  'password',
  'passwd',
  'token',
  'api_key',
  'api-key',
  'apikey',
  'authorization',
  'credentials',
]

const SECRET_PREFIX_RE = /sk-[A-Za-z0-9_-]{8,}|xoxb-[A-Za-z0-9-]+|ghp_[A-Za-z0-9]{20,}/g

/**
 * Mask sensitive content within a permission rule string. Preserves the
 * Tool() shape and the leading argument segment so the rule is still
 * readable in the capability sheet, but redacts anything after a
 * sensitive keyword. Examples:
 *   `Read(/home/u/.ssh/id_ed25519)` → `Read(/home/u/.ssh/***)`
 *   `Bash(curl -H "Authorization: Bearer abc")` → `Bash(curl -H "Authorization: ***")`
 */
const maskSensitiveRule = (rule: string): string => {
  let out = rule
  for (const kw of SENSITIVE_KEYWORDS) {
    const idx = out.toLowerCase().indexOf(kw)
    if (idx < 0) continue
    // Find the next character after the keyword and replace everything up
    // to a closing paren, quote, or end-of-string with ***. Preserves the
    // closing bracket so the rule stays parseable.
    const tail = out.slice(idx + kw.length)
    const stop = tail.search(/[)"\s]/)
    const cut = stop >= 0 ? idx + kw.length + stop : out.length - 1
    out = out.slice(0, idx + kw.length) + '/***' + out.slice(cut)
  }
  // Strip embedded literal credentials (rare but worth catching).
  out = out.replace(SECRET_PREFIX_RE, '***')
  return out
}

const readPermissions = async (
  settingsPath: string,
  scope: 'user' | 'project',
): Promise<{ group: PermissionGroup | null; addlDirs: string[]; defaultMode?: string }> => {
  const settings = await safeReadJson<any>(settingsPath)
  if (!settings?.permissions) {
    return { group: null, addlDirs: [], defaultMode: undefined }
  }
  const p = settings.permissions
  const group: PermissionGroup = {
    scope,
    allow: Array.isArray(p.allow) ? p.allow.map((r: any) => maskSensitiveRule(String(r))) : [],
    ask: Array.isArray(p.ask) ? p.ask.map((r: any) => maskSensitiveRule(String(r))) : [],
  }
  return {
    group,
    addlDirs: Array.isArray(p.additionalDirectories)
      ? p.additionalDirectories.map((d: any) => maskSensitiveRule(String(d)))
      : [],
    defaultMode: typeof p.defaultMode === 'string' ? p.defaultMode : undefined,
  }
}

// ── memory loader ────────────────────────────────────────────────────────────

// `encodeCwd` + `ancestorProjectScopes` now live in ./graph/projectScopes.js so
// the recall route and this sheet share one definition (imported above).

/**
 * Pull memories the current cwd is likely to care about from the graph,
 * one bucket per scope source so each gets fair representation in the
 * SessionStart context. Without per-bucket limits, recent vault imports
 * drown out user-wide and project-specific memories.
 *
 * Sources (in priority order — earlier buckets render higher):
 *   1. user scope                  — top 10 by syncedAt
 *   2. project:<encoded-cwd> scope — top 15 by syncedAt
 *   3. vault:* scopes              — top 10 by syncedAt
 *
 * Excludes patterns, concepts, and *-divergence — those surface via
 * dedicated hooks (recall, aware) when contextually relevant.
 */
const fetchRelevantMemories = async (
  cwd: string | undefined,
): Promise<MemoryInfo[]> => {
  const { all } = await import('./graph/db.js')

  // kind exclusions: drop pattern/concept and any *-divergence kind. The
  // substring (CONTAINS) match on 'divergence' is a NOT LIKE in SQLite.
  const skipClause =
    `kind <> 'pattern' AND kind <> 'concept' AND kind NOT LIKE '%divergence%' ESCAPE '\\'`

  const queryBucket = (
    scopeFilter: string,
    params: any[],
    limit: number,
  ): MemoryInfo[] => {
    try {
      const rows = all<{
        id: string
        name: string
        scope: string
        kind: string
        description: string
        content: string
        syncedAt: number | bigint
        engagement: number | bigint | null
      }>(
        `SELECT id AS id, name AS name, scope AS scope, kind AS kind, ` +
          `       description AS description, content AS content, syncedAt AS syncedAt, ` +
          `       engagement AS engagement ` +
          `FROM entries ` +
          `WHERE ${scopeFilter} AND ${skipClause} ` +
          `ORDER BY syncedAt DESC LIMIT ?`,
        ...params,
        limit,
      )
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        scope: r.scope,
        kind: r.kind,
        description: r.description ?? '',
        bodyPreview: trimBody(r.content ?? ''),
        syncedAt: Number(r.syncedAt),
        engagement: Number(r.engagement ?? 0),
      }))
    } catch {
      return []
    }
  }

  const buckets: MemoryInfo[][] = []
  buckets.push(queryBucket(`scope = 'user'`, [], 10))
  if (cwd) {
    // Match cwd OR any ancestor — Claude Code projects often launch from
    // a parent dir, so memories under e.g. `project:-mnt-e-Repos-personal`
    // are still relevant when the user runs from a child like
    // `claude-config-dashboard/`.
    const scopes = ancestorProjectScopes(cwd)
    if (scopes.length > 0) {
      const orClause = scopes.map(() => `scope = ?`).join(' OR ')
      buckets.push(queryBucket(`(${orClause})`, scopes, 15))
    }
  }
  buckets.push(queryBucket(`scope LIKE 'vault:%' ESCAPE '\\'`, [], 10))

  return buckets.flat()
}

/**
 * Pull the human-profile perception (narrative + active facets above the
 * injection bar). Delegates to the profile
 * module's competing-group arbitration + live-decay. Best-effort: an empty
 * profile is fine (first runs, or no facets yet).
 */
const fetchProfile = (): ProfileView => {
  if (!profileEnabled()) return { narrative: '', facets: [] }  // opt-in: off ⇒ no injection
  try {
    return getProfile({ minConfidence: INJECT_MIN })
  } catch {
    return { narrative: '', facets: [] }
  }
}

/**
 * Pick the SOFT interaction-override one-liners from the relevant memories:
 * authored `feedback` memories, MINUS any tagged `engagement` (those are hard
 * now — rendered into the managed CLAUDE.md block, so soft-injecting them would
 * state the same directive twice). Pure (no DB) so it is unit-testable.
 */
export const selectOverrides = (memories: MemoryInfo[]): string[] =>
  memories
    .filter((m) => m.kind === 'feedback' && !m.engagement)
    .map((m) => m.description)
    .filter((d): d is string => Boolean(d && d.trim()))

/**
 * Render the "Your profile" section: the AI's perception of the human as a
 * descriptive read (NOT a rulebook), plus the human's authored interaction
 * overrides. Pure (no DB) so it is testable; the perception is not editable —
 * it changes only as the human behaves differently or argues a truer read.
 */
export const renderProfileSection = (
  profile: ProfileView,
  overrides: string[],
  onboarding = false,
): string => {
  const lines: string[] = []
  lines.push('### Your profile — how Cortex reads the human')
  lines.push(
    'Evidence-based perception, not rules. It shapes how you engage (style, anticipation, ' +
    'autonomy). You do not edit it; it changes only as the human behaves differently or argues ' +
    'a truer read in conversation.',
  )
  // First run with a blank profile: prompt the user (once) to seed how they want to be engaged.
  if (onboarding) {
    lines.push(
      '',
      '**This profile is blank — first run.** Cortex has no read of this human yet, so you are ' +
      'on generic defaults. Once, near the start of this session, offer to run **`/cortex-profile-setup`** ' +
      '— a short guided setup that seeds how they like to be engaged (answer length, autonomy, ' +
      'depth, time estimates, tone, code style). Those seeds are soft: they decay and are overtaken ' +
      'as real behavior accrues. If the user declines, respect it — this prompt will not appear again.',
    )
  }
  if (profile.narrative.trim()) lines.push('', profile.narrative.trim())
  if (profile.facets.length > 0) {
    lines.push('')
    for (const f of profile.facets.slice(0, 8)) {
      lines.push(`- **[${f.dimension}]** ${f.statement} _(confidence ${f.confidence.toFixed(2)}, ${f.trend}, ${f.evidence_count} sessions)_`)
    }
  }
  if (overrides.length > 0) {
    lines.push('', '**Interaction overrides the human has set** (honor these over the perception for *how* you engage):')
    for (const o of overrides.slice(0, 8)) lines.push(`- ${o}`)
  }
  return lines.join('\n')
}

const trimBody = (body: string): string => {
  const trimmed = body.trim()
  if (trimmed.length <= 600) return trimmed
  return trimmed.slice(0, 600) + '…'
}

// ── sheet compilation ────────────────────────────────────────────────────────

export const compileCapabilitySheet = async (cwd?: string): Promise<{
  data: CapabilitySheetData
  markdown: string
}> => {
  const home = os.homedir()
  const userClaudeDir = path.join(home, '.claude')

  // User scope is always read.
  const [userSkills, userAgents, userMcp, userPerms] = await Promise.all([
    readSkillsFromDir(path.join(userClaudeDir, 'skills'), 'user'),
    readAgentsFromDir(path.join(userClaudeDir, 'agents'), 'user'),
    readUserMcpServers(home),
    readPermissions(path.join(userClaudeDir, 'settings.json'), 'user'),
  ])

  // Project scope only if cwd is set and looks like a project root.
  let projectSkills: SkillInfo[] = []
  let projectAgents: AgentInfo[] = []
  let projectMcp: McpInfo[] = []
  let projectPerms: { group: PermissionGroup | null; addlDirs: string[]; defaultMode?: string } = {
    group: null,
    addlDirs: [],
    defaultMode: undefined,
  }
  if (cwd) {
    const projClaudeDir = path.join(cwd, '.claude')
    const [skills, agents, mcp, perms] = await Promise.all([
      readSkillsFromDir(path.join(projClaudeDir, 'skills'), 'project'),
      readAgentsFromDir(path.join(projClaudeDir, 'agents'), 'project'),
      readProjectMcpServers(cwd),
      readPermissions(path.join(projClaudeDir, 'settings.json'), 'project'),
    ])
    projectSkills = skills
    projectAgents = agents
    projectMcp = mcp
    projectPerms = perms
  }

  const { loadAgentIdentity, renderIdentitySection } = await import('./identity.js')
  const [memories, identity] = await Promise.all([
    fetchRelevantMemories(cwd),
    loadAgentIdentity(cwd),
  ])

  // Interaction overrides are the human's authored `feedback` memories —
  // already surfaced in `memories`; we lift their descriptions as one-liners.
  // Engagement-tagged feedback is excluded — it's rendered into the HARD
  // managed CLAUDE.md block instead, so soft-injecting it would state it twice.
  const overrides = selectOverrides(memories)

  // First-run onboarding: blank profile + not-yet-shown. Writing the marker here (when the
  // nudge is actually emitted) makes it one-time even if the user ignores it. Only the
  // SessionStart/PostCompact hook builds the sheet, so this never fires on a UI fetch.
  const onboarding = await onboardingPending()
  if (onboarding) await markOnboardingShown()

  const data: CapabilitySheetData = {
    skills: [...userSkills, ...projectSkills],
    agents: [...userAgents, ...projectAgents],
    mcpServers: [...userMcp.filter((m) => m.enabled), ...projectMcp.filter((m) => m.enabled)],
    permissions: [userPerms.group, projectPerms.group].filter(
      (g): g is PermissionGroup => g !== null,
    ),
    additionalDirectories: [...userPerms.addlDirs, ...projectPerms.addlDirs],
    defaultMode: projectPerms.defaultMode ?? userPerms.defaultMode,
    memories,
    identityMarkdown: renderIdentitySection(identity),
    profile: fetchProfile(),
    overrides,
    onboarding,
    profileEnabled: profileEnabled(),
  }

  return { data, markdown: renderMarkdown(data) }
}

export const renderMarkdown = (d: CapabilitySheetData): string => {
  const lines: string[] = []
  lines.push('## Cortex — your capabilities (compiled at session start)')
  lines.push('')
  lines.push(
    'This is a structural inventory of what you have access to. ' +
      'Read it before suggesting the user run a command.',
  )
  lines.push('')

  // Identity comes before everything else — who you are shapes how you
  // read the rest. Only rendered when ~/.config/ckn/identity.yaml exists.
  if (d.identityMarkdown) {
    lines.push(d.identityMarkdown)
  }

  // Your profile — the AI's evidence-grounded perception of the human plus
  // the human's authored interaction overrides. Replaces the raw
  // "observed about this user" block (perception is now arbitrated +
  // decayed by the profile module, not a flat observation dump).
  // Personality profile is opt-in (CKN_PROFILE). When enabled, render the
  // perception frame (heading + framing even when empty, so it's established
  // from session one). When off, omit the section entirely — fully silent.
  if (d.profileEnabled) {
    lines.push(renderProfileSection(d.profile, d.overrides, d.onboarding))
    lines.push('')
  }

  // Skills — usually the highest-leverage section.
  if (d.skills.length > 0) {
    lines.push('### Skills')
    lines.push('')
    for (const s of d.skills) {
      const tools = s.allowedTools?.length ? ` _(uses: ${s.allowedTools.join(', ')})_` : ''
      const scopeTag = s.scope === 'project' ? ' `[project]`' : ''
      lines.push(`- **${s.name}**${scopeTag} — ${s.description || '(no description)'}${tools}`)
    }
    lines.push('')
  }

  // MCP servers — important for tool discovery.
  if (d.mcpServers.length > 0) {
    lines.push('### MCP servers (additional tools)')
    lines.push('')
    for (const m of d.mcpServers) {
      const scopeTag = m.scope === 'project' ? ' `[project]`' : ''
      lines.push(`- \`${m.name}\`${scopeTag} — tools prefixed \`${m.toolPrefix}*\``)
    }
    lines.push('')
  }

  // Sub-agents.
  if (d.agents.length > 0) {
    lines.push('### Sub-agents available')
    lines.push('')
    for (const a of d.agents) {
      const scopeTag = a.scope === 'project' ? ' `[project]`' : ''
      lines.push(`- **${a.name}**${scopeTag} — ${a.description || '(no description)'}`)
    }
    lines.push('')
  }

  // Permissions.
  if (d.permissions.length > 0) {
    lines.push('### Permissions you have (auto-approved without asking)')
    lines.push('')
    const allAllow = d.permissions.flatMap((p) => p.allow)
    const allAsk = d.permissions.flatMap((p) => p.ask)
    if (allAllow.length > 0) {
      lines.push('**Allow:**')
      lines.push('')
      for (const a of allAllow) lines.push(`- \`${a}\``)
      lines.push('')
    }
    if (allAsk.length > 0) {
      lines.push('**Ask before running:**')
      lines.push('')
      for (const a of allAsk) lines.push(`- \`${a}\``)
      lines.push('')
    }
    if (d.defaultMode) {
      lines.push(`Default mode: \`${d.defaultMode}\``)
      lines.push('')
    }
  }

  if (d.additionalDirectories.length > 0) {
    lines.push('### Additional readable directories')
    lines.push('')
    for (const dir of d.additionalDirectories) lines.push(`- \`${dir}\``)
    lines.push('')
  }

  // Memory recall — the most recent project + user memories from the
  // Cortex graph DB. Bounded to keep the additionalContext lean; full
  // content is in the graph and queryable on demand via the search API.
  // Includes pre-compact checkpoints (kind:'precompact-checkpoint')
  // so a session recovering from /compact has its prior context
  // visible — see bin/ckn-precompact.ts for the capture path.
  if (d.memories.length > 0) {
    lines.push('### Recent memory context (project + user scope)')
    lines.push('')
    lines.push(
      'Memory entries from the graph that are relevant to the current cwd. Ordered by recency. ' +
        "Each is a thing the user (or a previous session) decided was worth remembering. Read these at session start so you're operating with the same context they'd expect.",
    )
    lines.push('')
    // Group by scope for readability — user-wide first, then project, then vaults.
    const buckets: Record<string, MemoryInfo[]> = {}
    for (const m of d.memories) {
      const key =
        m.scope === 'user'
          ? 'User-wide'
          : m.scope.startsWith('project:')
            ? 'This project'
            : m.scope.startsWith('vault:')
              ? `Imported vault: ${m.scope.slice('vault:'.length)}`
              : m.scope
      if (!buckets[key]) buckets[key] = []
      buckets[key].push(m)
    }
    const order = [
      'User-wide',
      'This project',
      ...Object.keys(buckets).filter(
        (k) => k !== 'User-wide' && k !== 'This project',
      ),
    ]
    for (const bucket of order) {
      const items = buckets[bucket]
      if (!items || items.length === 0) continue
      lines.push(`**${bucket}** (${items.length})`)
      lines.push('')
      for (const m of items) {
        // Cap the per-bucket render so a single huge bucket doesn't eat
        // the whole context window.
        if (m.bodyPreview) {
          lines.push(`- **${m.name}** _(${m.kind})_ — ${m.description || '(no description)'}`)
          // Indent body so it reads as a quotation block.
          for (const ln of m.bodyPreview.split('\n')) {
            lines.push(`  ${ln}`)
          }
        } else {
          lines.push(`- **${m.name}** _(${m.kind})_ — ${m.description || '(no description)'}`)
        }
      }
      lines.push('')
    }
    lines.push(
      `_Total: ${d.memories.length} memories. Run \`curl http://localhost:3001/api/graph/search?q=<term>\` for full-text search across the graph._`,
    )
    lines.push('')
  }

  // The lever — explicit operating instruction. Without this, the rest is
  // just an inventory that Claude won't necessarily use.
  lines.push('### Operating principle')
  lines.push('')
  lines.push(
    "**Before suggesting the user run a command, check this list.** If a skill, " +
      "MCP tool, or allow-permission covers what's needed, propose to run it yourself rather than instructing the user. " +
      "Examples: SSH commands → look for an ssh-related skill or MCP server before asking the user to ssh manually; " +
      "database queries → look for a database MCP server before printing SQL for the user to run; " +
      "shell automation → check `permissions.allow` for the matching `Bash(...)` rule before deferring.",
  )
  lines.push('')
  lines.push(
    'When you are uncertain whether you have a capability, ask the user — but lead with what you found in this list, ' +
      'not with "you should run X."',
  )
  lines.push('')

  return lines.join('\n')
}
