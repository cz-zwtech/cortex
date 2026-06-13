import type { Kind } from '@/ontology'
import type { EntityIndex, RawRef, ReferenceExtractor } from './types'
import { fmString, fmStringList, frontmatterOf } from './frontmatter'
import {
  scanImports,
  scanMcpTools,
  scanProseAgents,
  scanProseCommands,
  scanProseSkills,
} from './scanners'

// ── helpers shared by most extractors ──────────────────────────────────────────

const proseAll = (text: string, ctx: EntityIndex): RawRef[] => [
  ...scanProseCommands(text, ctx.namesByKind('command')),
  ...scanProseAgents(text, ctx.namesByKind('agent')),
  ...scanProseSkills(text, ctx.namesByKind('skill')),
]

const fmList = (
  fm: Record<string, unknown>,
  field: string,
  toKind: Kind,
): RawRef[] =>
  fmStringList(fm, field).map((name) => ({
    toKind,
    toName: name,
    source: { kind: 'frontmatter', field },
  }))

const fmOne = (
  fm: Record<string, unknown>,
  field: string,
  toKind: Kind,
): RawRef[] => {
  const v = fmString(fm, field)
  return v ? [{ toKind, toName: v, source: { kind: 'frontmatter', field } }] : []
}

// ── per-kind extractors ────────────────────────────────────────────────────────

const agent: ReferenceExtractor = (e, ctx) => {
  const v = e.value as any
  const fm = frontmatterOf(e.raw)
  const body = typeof v.body === 'string' ? v.body : ''
  const toolText = [
    ...(Array.isArray(v.tools) ? v.tools : []),
    ...fmStringList(fm, 'tools'),
    ...fmStringList(fm, 'disallowedTools'),
  ].join(' ')
  return [
    ...fmList(fm, 'skills', 'skill'),
    ...fmList(fm, 'mcpServers', 'mcp'),
    ...fmList(fm, 'hooks', 'hook'),
    ...fmList(fm, 'memory', 'memory'),
    ...scanMcpTools(toolText, 'tool'),
    ...scanImports(body),
    ...proseAll(body + '\n' + (v.description ?? ''), ctx),
  ]
}

const command: ReferenceExtractor = (e, ctx) => {
  const v = e.value as any
  const fm = frontmatterOf(e.raw)
  const body = typeof v.body === 'string' ? v.body : ''
  const toolText = [
    ...fmStringList(fm, 'allowed-tools'),
    ...fmStringList(fm, 'allowedTools'),
    ...fmStringList(fm, 'disallowed-tools'),
    ...fmStringList(fm, 'disallowedTools'),
  ].join(' ')
  return [
    ...scanMcpTools(toolText, 'tool'),
    ...scanImports(body),
    ...proseAll(body + '\n' + (v.description ?? ''), ctx),
  ]
}

const skill: ReferenceExtractor = (e, ctx) => {
  const v = e.value as any
  const fm = frontmatterOf(e.raw)
  const body = typeof v.body === 'string' ? v.body : ''
  const toolText = [
    ...(Array.isArray(v.allowedTools) ? v.allowedTools : []),
    ...fmStringList(fm, 'allowed-tools'),
    ...fmStringList(fm, 'allowedTools'),
  ].join(' ')
  return [
    ...fmOne(fm, 'agent', 'agent'),
    ...scanMcpTools(toolText, 'tool'),
    ...scanImports(body),
    ...proseAll(body + '\n' + (v.description ?? ''), ctx),
  ]
}

const rule: ReferenceExtractor = (e, ctx) => {
  const v = e.value as any
  const body = typeof v.body === 'string' ? v.body : ''
  return [
    ...scanImports(body),
    ...proseAll(body + '\n' + (v.description ?? ''), ctx),
  ]
}

const claudemd: ReferenceExtractor = (e, ctx) => {
  const v = e.value as any
  const body = typeof v.body === 'string' ? v.body : ''
  return [
    ...scanImports(body),
    ...proseAll(body, ctx),
  ]
}

const memory: ReferenceExtractor = (e, ctx) => {
  const v = e.value as any
  const body = typeof v.body === 'string' ? v.body : ''
  return [
    ...scanImports(body),
    ...proseAll(body + '\n' + (v.description ?? ''), ctx),
  ]
}

const hook: ReferenceExtractor = (e, ctx) => {
  const v = e.value as any
  const matcher = typeof v.matcher === 'string' ? v.matcher : ''
  const commands = Array.isArray(v.handlers)
    ? v.handlers.map((h: any) => (typeof h.command === 'string' ? h.command : '')).join('\n')
    : ''
  return [
    ...scanMcpTools(matcher, 'matcher'),
    ...scanMcpTools(commands, 'tool'),
    ...proseAll(commands, ctx),
  ]
}

// ── registry ───────────────────────────────────────────────────────────────────

/**
 * Which kinds participate in the reference graph.
 * - `mcp`: no body/description, can only be a *target* of refs.
 * - `conversation`: historical transcripts, not configuration.
 */
export const referenceExtractors: Partial<Record<Kind, ReferenceExtractor>> = {
  agent,
  command,
  skill,
  rule,
  claudemd,
  memory,
  hook,
}
