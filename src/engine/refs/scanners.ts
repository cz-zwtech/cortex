import type { RawRef } from './types'

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `@path/to/file.md` — Claude Code CLAUDE.md / rule imports.
 * Emits a ref for each kind the path could refer to (claudemd, rule, memory);
 * the resolver picks whichever kind actually exists.
 */
export const scanImports = (text: string): RawRef[] => {
  if (!text) return []
  const re = /(?:^|[\s(])@(~?\/?[\w./-]+\.md)\b/g
  const out: RawRef[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const path = m[1]
    if (!path || seen.has(path)) continue
    seen.add(path)
    const source = { kind: 'import' as const, path }
    out.push({ toKind: 'claudemd', toName: path, source })
    out.push({ toKind: 'rule',     toName: path, source })
    out.push({ toKind: 'memory',   toName: path, source })
  }
  return out
}

/**
 * `mcp__server__tool` — tool-identifier syntax used in hook matchers,
 * allowed-tools lists, and subagent tools. We only care about the server name
 * (each server can expose many tools; we collapse to one ref per server).
 */
export const scanMcpTools = (
  text: string,
  via: 'tool' | 'matcher',
): RawRef[] => {
  if (!text) return []
  const re = /\bmcp__([a-zA-Z0-9_-]+)(?:__[a-zA-Z0-9_.*-]+)?\b/g
  const out: RawRef[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const server = m[1]
    const full = m[0]
    if (!server || seen.has(server)) continue
    seen.add(server)
    out.push({
      toKind: 'mcp',
      toName: server,
      source: via === 'tool'
        ? { kind: 'tool', tool: full }
        : { kind: 'matcher', pattern: full },
    })
  }
  return out
}

/** Find every `/name` slash-command invocation matching a known command name. */
export const scanProseCommands = (text: string, knownNames: string[]): RawRef[] => {
  if (!text) return []
  const out: RawRef[] = []
  for (const name of knownNames) {
    if (new RegExp(`(?:^|\\s|\\()/${escape(name)}\\b`).test(text)) {
      out.push({ toKind: 'command', toName: name, source: { kind: 'prose' } })
    }
  }
  return out
}

/** `subagent_type: "name"` / `agent: "name"` style mentions in prose. */
export const scanProseAgents = (text: string, knownNames: string[]): RawRef[] => {
  if (!text) return []
  const out: RawRef[] = []
  for (const name of knownNames) {
    if (new RegExp(`\\b(?:subagent_type|agent)\\s*[:=]\\s*["']?${escape(name)}["']?\\b`).test(text)) {
      out.push({ toKind: 'agent', toName: name, source: { kind: 'prose' } })
    }
  }
  return out
}

/** `skill: name` / `Skill "name"` style mentions in prose. */
export const scanProseSkills = (text: string, knownNames: string[]): RawRef[] => {
  if (!text) return []
  const out: RawRef[] = []
  for (const name of knownNames) {
    if (new RegExp(`\\bskill[:\\s]+["']?${escape(name)}["']?\\b`, 'i').test(text)) {
      out.push({ toKind: 'skill', toName: name, source: { kind: 'prose' } })
    }
  }
  return out
}
