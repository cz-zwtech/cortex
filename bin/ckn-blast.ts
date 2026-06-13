#!/usr/bin/env tsx
/**
 * ckn-blast — the blast-radius query primitive (for humans AND agents).
 *
 *   ckn-blast <path> [symbol]
 *   ckn-blast server/graph/db.ts                 # file mode: cross-file blast
 *   ckn-blast server/graph/db.ts getConnection   # symbol mode: who depends on it
 *
 * Flags:
 *   --branch <b>   query a specific branch (default: the path's current branch)
 *   --base <b>     base branch for overlay (default: GraphHead / git default)
 *   --no-refresh   answer the snapshot even if stale (skip the auto re-ingest)
 *   --kinds <list> comma list of edge kinds (CALLS,IMPORTS,EXTENDS,IMPLEMENTS,REFERENCES)
 *   --deps         also show what the target DEPENDS ON (off by default)
 *   --all          list every symbol candidate when the name is ambiguous
 *   --json         machine-readable output for agents
 *
 * Flow: resolveTarget → ensureFresh → (symbol) GET /symbols/<id>/dependents
 * | (file) POST /symbols/blast → render impacted-first.
 *
 * API-first like every Cortex CLI: it talks to the running server, never opens
 * the graph DB directly.
 */
import { SERVER_URL } from './_graph-guard.js'
import { resolveTarget, type ResolvedTarget } from './_blast-target.js'
import { ensureFresh, type FreshnessResult } from './_blast-freshness.js'
import { SYMBOL_EDGE_TABLES, type SymbolEdgeKind } from '../server/graph/symbols.js'
import type { SymbolRow } from '../server/graph/_rows.js'

interface Impacted {
  name: string
  file: string
  line: number
  kind: string
  edgeKind?: string
}

interface BlastOutput {
  target: {
    repo: string
    file: string
    branch: string
    baseBranch: string
    symbol?: string
    mode: 'file' | 'symbol'
  }
  freshness: FreshnessResult
  impacted: Impacted[]
  dependsOn?: Impacted[]
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function flagVal(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

function parseKinds(): SymbolEdgeKind[] | undefined {
  const raw = flagVal('kinds')
  if (!raw) return undefined
  const kinds = raw
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter((k): k is SymbolEdgeKind => (SYMBOL_EDGE_TABLES as readonly string[]).includes(k))
  return kinds.length ? kinds : undefined
}

/** Positional args = everything that isn't a flag or a flag's value. */
function positionals(): string[] {
  const flagsWithValue = new Set(['branch', 'base', 'kinds'])
  const out: string[] = []
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      if (flagsWithValue.has(a.slice(2))) i++ // skip its value
      continue
    }
    out.push(a)
  }
  return out
}

/** Group impacted rows by file for a tidy, scan-able render. */
function groupByFile(rows: Impacted[]): Map<string, Impacted[]> {
  const m = new Map<string, Impacted[]>()
  for (const r of rows) {
    const arr = m.get(r.file) ?? []
    arr.push(r)
    m.set(r.file, arr)
  }
  for (const arr of m.values()) arr.sort((a, b) => a.line - b.line)
  return new Map([...m.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function symbolRowToImpacted(s: SymbolRow): Impacted {
  return { name: s.name, file: s.file, line: s.line, kind: s.symbolKind }
}

async function querySymbolMode(
  symbolId: string,
  kinds: SymbolEdgeKind[] | undefined,
): Promise<{ impacted: Impacted[]; dependsOn: Impacted[] }> {
  const u = new URL(`${SERVER_URL}/api/graph/symbols/${encodeURIComponent(symbolId)}/dependents`)
  if (kinds) u.searchParams.set('kinds', kinds.join(','))
  const res = await fetch(u)
  if (res.status === 404) throw new Error(`symbol not in the graph: ${symbolId}`)
  if (!res.ok) throw new Error(`dependents query HTTP ${res.status}`)
  const body = (await res.json()) as { dependents?: SymbolRow[]; dependencies?: SymbolRow[] }
  return {
    impacted: (body.dependents ?? []).map(symbolRowToImpacted),
    dependsOn: (body.dependencies ?? []).map(symbolRowToImpacted),
  }
}

async function queryFileMode(
  target: ResolvedTarget,
  kinds: SymbolEdgeKind[] | undefined,
): Promise<{ impacted: Impacted[] }> {
  const res = await fetch(`${SERVER_URL}/api/graph/symbols/blast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repo: target.repo,
      paths: [target.file],
      branch: target.branch,
      baseBranch: target.baseBranch,
      ...(kinds ? { kinds } : {}),
    }),
  })
  if (!res.ok) throw new Error(`blast query HTTP ${res.status}`)
  const body = (await res.json()) as {
    symbols?: { dependents?: { name: string; file: string; line: number; edgeKind: string }[] }[]
  }
  const impacted: Impacted[] = []
  const seen = new Set<string>()
  for (const s of body.symbols ?? []) {
    for (const d of s.dependents ?? []) {
      const key = `${d.file}#${d.name}#${d.line}`
      if (seen.has(key)) continue
      seen.add(key)
      impacted.push({ name: d.name, file: d.file, line: d.line, kind: '', edgeKind: d.edgeKind })
    }
  }
  return { impacted }
}

function renderHuman(out: BlastOutput, showDeps: boolean): string {
  const lines: string[] = []
  const t = out.target
  const sym = t.symbol ? ` · ${t.symbol}` : ''
  lines.push(`Blast radius · ${t.repo} · ${t.file}${sym}`)
  lines.push(
    `branch=${t.branch || '(default)'} base=${t.baseBranch} · freshness: ${out.freshness.status}` +
      (out.freshness.detail ? ` (${out.freshness.detail})` : ''),
  )
  lines.push('')
  lines.push(`Impacted if you change this (${out.impacted.length})`)
  if (out.impacted.length === 0) {
    lines.push('  (no cross-file dependents found)')
  } else {
    for (const [file, rows] of groupByFile(out.impacted)) {
      lines.push(`  ${file}`)
      for (const r of rows) {
        const ek = r.edgeKind ? ` [${r.edgeKind}]` : ''
        const kind = r.kind ? `${r.kind} ` : ''
        lines.push(`    ${file}:${r.line} ${kind}${r.name}${ek}`)
      }
    }
  }
  if (showDeps && out.dependsOn) {
    lines.push('')
    lines.push(`Depends on (${out.dependsOn.length})`)
    if (out.dependsOn.length === 0) {
      lines.push('  (none)')
    } else {
      for (const [file, rows] of groupByFile(out.dependsOn)) {
        lines.push(`  ${file}`)
        for (const r of rows) {
          const kind = r.kind ? `${r.kind} ` : ''
          lines.push(`    ${file}:${r.line} ${kind}${r.name}`)
        }
      }
    }
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const pos = positionals()
  if (pos.length === 0) {
    throw new Error('usage: ckn-blast <path> [symbol] [--branch b] [--base b] [--deps] [--json] [--no-refresh] [--kinds CALLS,IMPORTS] [--all]')
  }
  const [pathArg, symbolArg] = pos
  const kinds = parseKinds()
  const showDeps = hasFlag('deps')
  const asJson = hasFlag('json')
  const showAll = hasFlag('all')

  const resolveInput = {
    path: pathArg!,
    symbol: symbolArg,
    branch: flagVal('branch'),
    base: flagVal('base'),
  }
  let target = await resolveTarget(resolveInput)

  // Freshness FIRST (per the spec's resolveTarget → ensureFresh → query flow):
  // a query on a branch whose graph isn't ingested yet is stale, so re-ingest
  // before deciding a symbol is "not found". Then re-resolve once so the symbol
  // matches against the freshly-ingested branch.
  const freshness = await ensureFresh(target, { refresh: !hasFlag('no-refresh') })
  if (
    freshness.status === 'refreshed' &&
    target.mode === 'symbol' &&
    !target.symbolId
  ) {
    target = await resolveTarget(resolveInput)
  }

  // Ambiguity / not-found in symbol mode — report before querying.
  if (target.mode === 'symbol' && !target.symbolId) {
    if (target.candidates && target.candidates.length) {
      const shown = showAll ? target.candidates : target.candidates.slice(0, 10)
      if (asJson) {
        console.log(JSON.stringify({ ambiguous: true, candidates: target.candidates }, null, 2))
      } else {
        console.error(`Ambiguous symbol "${symbolArg}" — ${target.candidates.length} matches:`)
        for (const c of shown) console.error(`  ${c.file}:${c.line} ${c.symbolKind} ${c.name}`)
        if (!showAll && target.candidates.length > shown.length) {
          console.error(`  …(+${target.candidates.length - shown.length} more; --all to list)`)
        }
        console.error('Disambiguate by passing the exact name (e.g. Class.method) or narrowing the path.')
      }
      process.exit(2)
    }
    const hint = target.ungraphed
      ? ` The repo "${target.repo}" isn't in the graph — run: ckn-codegraph ${target.repoRoot}`
      : ''
    if (asJson) console.log(JSON.stringify({ notFound: true, symbol: symbolArg }, null, 2))
    else console.error(`Symbol "${symbolArg}" not found in ${target.repo}:${target.file}.${hint}`)
    process.exit(2)
  }

  let impacted: Impacted[] = []
  let dependsOn: Impacted[] | undefined
  if (target.mode === 'symbol') {
    const r = await querySymbolMode(target.symbolId!, kinds)
    impacted = r.impacted
    if (showDeps) dependsOn = r.dependsOn
  } else {
    const r = await queryFileMode(target, kinds)
    impacted = r.impacted
    // File mode has no single "depends on" set; --deps is a symbol-mode notion.
    if (showDeps) dependsOn = []
  }

  const out: BlastOutput = {
    target: {
      repo: target.repo,
      file: target.file,
      branch: target.branch,
      baseBranch: target.baseBranch,
      symbol: symbolArg,
      mode: target.mode,
    },
    freshness,
    impacted,
    ...(showDeps ? { dependsOn } : {}),
  }

  if (asJson) console.log(JSON.stringify(out, null, 2))
  else console.log(renderHuman(out, showDeps))
}

main().catch((err) => {
  console.error(`[ckn-blast] ${err?.message ?? err}`)
  process.exit(1)
})
