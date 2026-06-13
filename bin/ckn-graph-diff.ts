#!/usr/bin/env tsx
/**
 * ckn-graph-diff — graph branch-diff: predict COMPETING changes between two
 * branches BEFORE a text-level merge conflict (spec Phase 4).
 *
 *   ckn-graph-diff <repo|path> <branchA> <branchB>
 *   ckn-graph-diff .            epic/x feature/y    # path → derived repo name
 *   ckn-graph-diff merit        epic/x feature/y    # explicit repo name
 *
 * Flags:
 *   --base <b>   common base branch for the competing-change comparison
 *                (default: the repo's GraphHead-resolved base)
 *   --json       machine-readable output for agents
 *
 * Output is COMPETING-FIRST (the conflict warning) — naturalIds touched on both
 * branches vs the base — then added / removed / changed. Compares symbol sets by
 * naturalId (the same symbol across branches), so it catches "both branches
 * edited Foo.bar" that a line diff would only surface at merge time.
 *
 * API-first like every Cortex CLI: talks to the running server, never opens the
 * graph DB directly. A path arg is resolved to a repo name via the same
 * derivation the ingest path uses (git-remote basename, else dir name).
 */
import path from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { SERVER_URL } from './_graph-guard.js'
import { deriveRepoName } from './_repo-name.js'

interface DiffSymbol {
  naturalId: string
  name: string
  symbolKind: string
  file: string
  line: number
}
interface BranchDiff {
  repo: string
  a: string
  b: string
  base: string
  added: DiffSymbol[]
  removed: DiffSymbol[]
  changed: DiffSymbol[]
  competing: DiffSymbol[]
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function flagVal(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

/** Positional args = everything that isn't a flag or a flag's value. */
function positionals(): string[] {
  const flagsWithValue = new Set(['base'])
  const out: string[] = []
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      if (flagsWithValue.has(a.slice(2))) i++
      continue
    }
    out.push(a)
  }
  return out
}

/** If the first arg is an existing directory, derive the repo name; else use it verbatim. */
function resolveRepo(repoOrPath: string): string {
  try {
    const abs = path.resolve(repoOrPath)
    if (existsSync(abs) && statSync(abs).isDirectory()) return deriveRepoName(abs)
  } catch {
    // not a path — treat as a literal repo name
  }
  return repoOrPath
}

function renderGroup(title: string, rows: DiffSymbol[]): string[] {
  const lines: string[] = [`${title} (${rows.length})`]
  if (rows.length === 0) {
    lines.push('  (none)')
    return lines
  }
  // group by file for a scan-able render
  const byFile = new Map<string, DiffSymbol[]>()
  for (const r of rows) {
    const arr = byFile.get(r.file) ?? []
    arr.push(r)
    byFile.set(r.file, arr)
  }
  for (const [file, group] of [...byFile.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    lines.push(`  ${file}`)
    for (const r of group.sort((x, y) => x.line - y.line)) {
      const kind = r.symbolKind ? `${r.symbolKind} ` : ''
      lines.push(`    ${file}:${r.line} ${kind}${r.name}`)
    }
  }
  return lines
}

function renderHuman(diff: BranchDiff): string {
  const lines: string[] = []
  lines.push(`Graph branch-diff · ${diff.repo} · ${diff.a} ↔ ${diff.b} (base=${diff.base})`)
  lines.push('')
  // COMPETING FIRST — the headline conflict warning.
  if (diff.competing.length > 0) {
    lines.push(`⚠ COMPETING CHANGES (${diff.competing.length}) — touched on BOTH branches vs base:`)
    lines.push(...renderGroup('  these may conflict at merge', diff.competing).map((l) => `  ${l}`))
  } else {
    lines.push('No competing changes — no symbol was touched on both branches vs base.')
  }
  lines.push('')
  lines.push(...renderGroup(`Added on ${diff.a}`, diff.added))
  lines.push('')
  lines.push(...renderGroup(`Removed (only on ${diff.b})`, diff.removed))
  lines.push('')
  lines.push(...renderGroup('Changed (differ between branches)', diff.changed))
  return lines.join('\n')
}

async function main(): Promise<void> {
  const pos = positionals()
  if (pos.length < 3) {
    throw new Error(
      'usage: ckn-graph-diff <repo|path> <branchA> <branchB> [--base b] [--json]',
    )
  }
  const [repoOrPath, a, b] = pos
  const repo = resolveRepo(repoOrPath!)
  const asJson = hasFlag('json')

  const u = new URL(`${SERVER_URL}/api/graph/symbols/branch-diff`)
  u.searchParams.set('repo', repo)
  u.searchParams.set('a', a!)
  u.searchParams.set('b', b!)
  const base = flagVal('base')
  if (base) u.searchParams.set('base', base)

  const res = await fetch(u)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`branch-diff query HTTP ${res.status}: ${text || res.statusText}`)
  }
  const diff = (await res.json()) as BranchDiff

  if (asJson) console.log(JSON.stringify(diff, null, 2))
  else console.log(renderHuman(diff))
}

main().catch((err) => {
  console.error(`[ckn-graph-diff] ${err?.message ?? err}`)
  process.exit(1)
})
