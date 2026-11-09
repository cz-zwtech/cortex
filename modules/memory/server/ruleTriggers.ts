/**
 * Scoped rules at the tool call: `when: tool:`, `path:` and `keywords:`.
 *
 * rules.ts parsed these triggers before anything evaluated them: outbound
 * audit runs `text_for:` and `always` rules only, and rules.md carries only
 * `always`. So a rule scoped to a tool was never in front of the session at
 * that tool (a rule with `when: tool:WebFetch` was never shown at a WebFetch
 * call).
 *
 * `path:` is a file the call reads or writes (file_path, notebook_path);
 * `cwd:` is the folder the session stands in.
 *
 * Several triggers may be given, comma-separated, within one kind:
 * `tool:WebFetch,mcp__browser__*`. A `*` matches any run of
 * characters in a tool name; in a path, `*` stays within one directory and `**`
 * crosses them.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Rule } from './rules.js'

export type Call = {
  tool: string
  /** File paths the call touches (file_path, notebook_path, path). */
  paths: string[]
  cwd?: string
  /** The text going out or being written (a write's content, a send's message). Never a command line. */
  text: string
  /** The git repository the cwd is in, by its directory name. */
  repo?: string
  /** The session's comms roles, when known. */
  roles?: string[]
}

/** The repository a directory is in: the name of the nearest directory above it holding .git. */
export const repoOf = (dir: string | undefined): string | undefined => {
  for (let d = dir; d && d !== path.dirname(d); d = path.dirname(d)) if (fs.existsSync(path.join(d, '.git'))) return path.basename(d)
  return undefined
}

/** Paths, URLs and flags name the machine, not the subject (the constraint gate's lesson). */
const prose = (t: string) => t.replace(/(?:[A-Za-z]+:\/\/|~?\/|\.\.?\/)[^\s<>"'`]*/g, ' ').replace(/(^|\s)--?[\w-]+/g, ' ')

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

const toolGlob = (g: string) => new RegExp(`^${escape(g).replace(/\*/g, '.*')}$`)

const pathGlob = (g: string) => {
  const abs = g.startsWith('~/') ? `${os.homedir()}${g.slice(1)}` : g
  const re = escape(abs).replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
  // A glob without a leading slash may sit anywhere in the path.
  return new RegExp(abs.startsWith('/') ? `^${re}$` : `(^|/)${re}$`)
}

const list = (spec: string) =>
  spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** Whether a rule's `when:` fires on this call. `always` and `text_for:` belong to the outbound audit, not here. */
export const firesOn = (rule: Pick<Rule, 'when'>, call: Call): boolean => {
  const when = rule.when.trim()
  if (when.startsWith('tool:')) return list(when.slice(5)).some((g) => toolGlob(g).test(call.tool))
  // path: is the file a call reads or writes, never where the session stands: a cwd that drifted
  // into a docs folder would fire a docs-writing rule on every Bash and Monitor call.
  // A rule about the working folder says so with cwd:.
  if (when.startsWith('path:')) {
    const globs = list(when.slice(5)).map(pathGlob)
    return call.paths.some((p) => globs.some((g) => g.test(p)))
  }
  if (when.startsWith('cwd:')) {
    const globs = list(when.slice(4)).map(pathGlob)
    return !!call.cwd && globs.some((g) => g.test(call.cwd!))
  }
  if (when.startsWith('keywords:')) {
    // Two of the listed words, or the one word when only one is listed: one common word in a long
    // text is chance ('plan' in any message would fire a rule about plans).
    const text = prose(call.text).toLowerCase()
    const keys = list(when.slice(9))
    const hits = keys.filter((k) => new RegExp(`(^|[^a-z0-9])${escape(k.toLowerCase())}($|[^a-z0-9])`).test(text)).length
    return hits >= Math.min(2, keys.length)
  }
  return false
}

/**
 * Whether a rule's scope covers this call. Unknown is out: a reminder that does
 * not show costs less than one shown where it does not belong (otherwise a repo
 * rule, a role rule and a client rule could all fire on a Bash call in an
 * unrelated folder).
 *
 *   user                       always
 *   repo:<name>                the cwd is inside that git repository
 *   project:<glob>             the cwd matches
 *   role:<role>                the session holds that comms role
 *   client:<name>, counterparty:<name>
 *                              the name is in the outgoing text, a path, or the cwd
 *   client:*, counterparty:*   never at a tool call: no call says who the client is
 */
export const inScope = (rule: Pick<Rule, 'scope'>, call: Pick<Call, 'cwd' | 'repo' | 'roles' | 'text' | 'paths'>): boolean => {
  const s = rule.scope.trim()
  if (s === 'user' || s === '') return true
  if (s.startsWith('repo:')) return call.repo === s.slice(5)
  if (s.startsWith('project:')) return !!call.cwd && pathGlob(s.slice(8)).test(call.cwd)
  if (s.startsWith('role:')) return !!call.roles?.includes(s.slice(5))
  const subject = s.match(/^(?:client|counterparty):(.+)$/)?.[1]?.trim().toLowerCase()
  if (subject !== undefined) {
    if (!subject || subject === '*') return false
    const where = `${call.text}\n${call.paths.join('\n')}\n${call.cwd ?? ''}`.toLowerCase()
    return new RegExp(`(^|[^a-z0-9])${escape(subject)}($|[^a-z0-9])`).test(where)
  }
  return false
}
