/**
 * Cortex agent-identity layer.
 *
 * Replaces ad-hoc persona text scattered across CLAUDE.md / settings
 * with a single structured YAML file describing who the agent is
 * operating *as* in this user's context. Inspired by Hindsight's
 * Mission / Directives / Disposition triad: mission gives the broad
 * stance, directives are hard rules, disposition tunes soft style.
 *
 * Lookup priority (later overrides earlier):
 *   1. ~/.config/ckn/identity.yaml             — user-wide identity
 *   2. <cwd>/.claude/identity.yaml             — project override
 *
 * Surface: the capability sheet renders an "Operating identity" section
 * at the top of every SessionStart/PostCompact context dump so Claude
 * sees who they're being before they see what tools they have.
 *
 * The YAML parsing is intentionally tiny — no external dependency. We
 * accept a flat mapping with three keys (mission/directives/disposition);
 * anything else is ignored. If parsing fails the loader silently returns
 * null and the capability sheet skips the section.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

export interface AgentIdentity {
  mission: string | null
  directives: string[]
  disposition: Record<string, string | number | boolean>
  /** Which file(s) contributed to this resolved identity. */
  sources: string[]
}

const USER_IDENTITY_PATH = path.join(os.homedir(), '.config', 'ckn', 'identity.yaml')

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/**
 * Bare-bones YAML reader — supports the three shapes we care about:
 *   mission: string
 *   directives:
 *     - "..."
 *   disposition:
 *     key: value
 * No nested lists or maps. No flow style. Lines starting with # ignored.
 * Returns null if parsing produced nothing usable.
 */
const parseIdentityYaml = (text: string): {
  mission: string | null
  directives: string[]
  disposition: Record<string, string | number | boolean>
} | null => {
  const out = {
    mission: null as string | null,
    directives: [] as string[],
    disposition: {} as Record<string, string | number | boolean>,
  }
  let section: 'top' | 'directives' | 'disposition' = 'top'
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    // Top-level keys: column 0.
    if (/^[A-Za-z_][\w-]*\s*:/.test(line)) {
      const idx = line.indexOf(':')
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim()
      if (key === 'mission') {
        section = 'top'
        out.mission = stripQuotes(val) || null
      } else if (key === 'directives') {
        section = 'directives'
      } else if (key === 'disposition') {
        section = 'disposition'
      } else {
        section = 'top'
      }
      continue
    }
    // Indented list item (directive)
    if (section === 'directives') {
      const m = /^\s+-\s+(.*)$/.exec(line)
      if (m) {
        const v = stripQuotes(m[1]!.trim())
        if (v) out.directives.push(v)
      }
      continue
    }
    // Indented "key: value" inside disposition
    if (section === 'disposition') {
      const m = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
      if (m) {
        const key = m[1]!
        let val: string | number | boolean = stripQuotes(m[2]!.trim())
        if (val === 'true') val = true
        else if (val === 'false') val = false
        else if (val !== '' && !Number.isNaN(Number(val))) val = Number(val)
        if (!isEmpty(val)) out.disposition[key] = val
      }
    }
  }
  if (!out.mission && out.directives.length === 0 && Object.keys(out.disposition).length === 0) {
    return null
  }
  return out
}

const stripQuotes = (s: string): string => {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

const readIfExists = async (file: string): Promise<string | null> => {
  try {
    return await fsp.readFile(file, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Load the resolved identity for `cwd`. User-wide is the base; project
 * identity (if present at `<cwd>/.claude/identity.yaml`) overrides
 * mission and merges directives + disposition.
 *
 * Returns null when neither file exists or both fail to parse.
 */
export const loadAgentIdentity = async (cwd?: string): Promise<AgentIdentity | null> => {
  const sources: string[] = []
  const merged: AgentIdentity = {
    mission: null,
    directives: [],
    disposition: {},
    sources,
  }

  const userRaw = await readIfExists(USER_IDENTITY_PATH)
  if (userRaw) {
    const u = parseIdentityYaml(userRaw)
    if (u) {
      if (u.mission) merged.mission = u.mission
      merged.directives.push(...u.directives)
      Object.assign(merged.disposition, u.disposition)
      sources.push(USER_IDENTITY_PATH)
    }
  }

  if (cwd) {
    const projPath = path.join(cwd, '.claude', 'identity.yaml')
    const projRaw = await readIfExists(projPath)
    if (projRaw) {
      const p = parseIdentityYaml(projRaw)
      if (p) {
        if (p.mission) merged.mission = p.mission // project overrides
        merged.directives.push(...p.directives) // additive
        Object.assign(merged.disposition, p.disposition) // last-write-wins per key
        sources.push(projPath)
      }
    }
  }

  if (!merged.mission && merged.directives.length === 0 && Object.keys(merged.disposition).length === 0) {
    return null
  }
  return merged
}

/**
 * Render the identity block for inclusion at the top of the capability
 * sheet. Empty (null) when no identity files were found — callers
 * should skip the section in that case.
 */
export const renderIdentitySection = (identity: AgentIdentity | null): string | null => {
  if (!identity) return null
  const lines: string[] = []
  lines.push('### Operating identity')
  lines.push('')
  lines.push('This is who you are *being* in this session. Read before forming your response style.')
  lines.push('')
  if (identity.mission) {
    lines.push(`**Mission:** ${identity.mission}`)
    lines.push('')
  }
  if (identity.directives.length > 0) {
    lines.push('**Directives** (hard rules — follow exactly):')
    for (const d of identity.directives) lines.push(`- ${d}`)
    lines.push('')
  }
  const dispEntries = Object.entries(identity.disposition)
  if (dispEntries.length > 0) {
    lines.push('**Disposition** (soft style):')
    for (const [k, v] of dispEntries) lines.push(`- ${k}: ${v}`)
    lines.push('')
  }
  return lines.join('\n')
}
