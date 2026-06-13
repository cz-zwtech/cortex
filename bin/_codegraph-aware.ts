/**
 * Pure helpers for the PreToolUse codegraph reflex. No I/O — the hook handles
 * stdin/network/state; these just resolve + render so they're unit-testable.
 */
import * as path from 'node:path'
import type { CodegraphCache } from '../server/codegraphCache.js'

export interface ResolvedRepo {
  repo: string
  root: string
  relpath: string
}

export interface BlastDep {
  name: string
  file: string
  line: number
  edgeKind: string
}
export interface BlastLike {
  name: string
  file: string
  line: number
  dependents: BlastDep[]
}

/** True when `child` is `parent` or lives beneath it (path-segment boundary). */
function isUnder(parent: string, child: string): boolean {
  if (child === parent) return true
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep
  return child.startsWith(withSep)
}

/**
 * Map an absolute file path to the graphed repo that owns it. Longest matching
 * root wins (handles a graphed sub-repo nested inside a graphed parent).
 * Returns null when no graphed root contains the file.
 */
export function resolveGraphedRepo(
  filePath: string,
  cache: CodegraphCache,
): ResolvedRepo | null {
  const abs = path.resolve(filePath)
  let best: ResolvedRepo | null = null
  let bestLen = -1
  for (const { repo, root } of cache.repos) {
    if (!root) continue
    const absRoot = path.resolve(root)
    if (isUnder(absRoot, abs) && absRoot.length > bestLen) {
      best = { repo, root: absRoot, relpath: path.relative(absRoot, abs) }
      bestLen = absRoot.length
    }
  }
  return best
}

/** Stable per-(session,file) gate key so the blast injects once per file. */
export function blastGateKey(repo: string, relpath: string): string {
  return `codegraph-blast:${repo}:${relpath}`
}

/**
 * Render the blast-radius note. Caller passes only symbols that HAVE
 * cross-file dependents (quiet-by-default is the caller's gate). Caps the
 * output so a high-fan-in symbol doesn't flood context.
 */
export function renderCodegraphBlast(
  repo: string,
  branch: string,
  symbols: BlastLike[],
): string {
  const lines: string[] = []
  lines.push(`## Cortex codegraph · ${repo} (branch \`${branch || 'default'}\`)`)
  lines.push('')
  lines.push(
    `You're about to edit code in a graphed repo. The Cortex code graph says these symbols here have cross-file dependents — changing their signature/behavior touches the call sites below. Check them before you edit; query more with the \`codegraph\` skill.`,
  )
  lines.push('')
  const MAX_SYMBOLS = 8
  const MAX_DEPS = 6
  for (const s of symbols.slice(0, MAX_SYMBOLS)) {
    const deps = s.dependents.slice(0, MAX_DEPS)
    const more = s.dependents.length > MAX_DEPS ? ` (+${s.dependents.length - MAX_DEPS} more)` : ''
    lines.push(`- **${s.name}** (${s.file}:${s.line}) — ${s.dependents.length} dependent(s)${more}:`)
    for (const d of deps) {
      lines.push(`    - ${d.name} \`${d.file}:${d.line}\` [${d.edgeKind}]`)
    }
  }
  if (symbols.length > MAX_SYMBOLS) {
    lines.push(`- …and ${symbols.length - MAX_SYMBOLS} more symbol(s) with dependents.`)
  }
  return lines.join('\n').trim()
}

/** A file-knowledge hit — the subset of a RecallHit the render needs. */
export interface FileKnowledgeHit {
  name: string
  description: string
}

/**
 * Render the ABOUT tier-1 file-knowledge note: the memories the user has kept
 * that mention the file about to be edited. These are the user's OWN memories
 * (trusted, like the awareness `operational` block — not the untrusted
 * shared-mind block), surfaced at the highest-value moment Cortex owns: pre-edit.
 * Quiet by default — returns '' when there's nothing, so the caller injects
 * nothing. Capped at 3 one-line bullets to stay within the ratified ≤2-3 lines.
 */
export function renderFileKnowledge(
  _repo: string,
  file: string,
  hits: FileKnowledgeHit[],
): string {
  if (!hits.length) return ''
  const lines: string[] = []
  lines.push(`## Cortex · knowledge for ${file}`)
  lines.push('')
  lines.push('Memories you have kept that mention this file — check before editing:')
  for (const h of hits.slice(0, 3)) {
    const oneLine = (h.description || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    lines.push(`- **${h.name}**${oneLine ? ` — ${oneLine}` : ''}`)
  }
  return lines.join('\n').trim()
}
