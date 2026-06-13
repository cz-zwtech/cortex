/**
 * Blast-radius target resolver.
 *
 * Turns a CLI `<path> [symbol]` (plus `--branch`/`--base`) into a fully resolved
 * target the freshness gate + query layer can act on:
 *   - `repo`        — derived from the path's git remote / dir name (deriveRepoName)
 *   - `repoRoot`    — the git toplevel (so `file` can be made repo-relative)
 *   - `branch`/`baseBranch`/`provenance` — from readGitProvenance(repoRoot)
 *   - `file`        — repo-relative POSIX path (the key Symbol rows are stored under)
 *   - `mode`        — 'file' (no symbol given) or 'symbol' (a symbol qualifier given)
 *   - `symbolId`    — the qualified Symbol id, when a single symbol matched
 *   - `candidates`  — when the symbol qualifier was ambiguous (CLI lists them)
 *
 * The symbol-matching core (`matchSymbol`) is a pure function over an INJECTED
 * symbol list so it's unit-testable without a server or a graph. `resolveTarget`
 * threads the real `listSymbols` (via the server API) in by default; tests inject
 * stubs through `deps`.
 */
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { deriveRepoName } from './_repo-name.js'
import { readGitProvenance, type GitProvenance } from '../server/git/provenance.js'
import type { SymbolRow } from '../server/graph/_rows.js'
import { SERVER_URL } from './_graph-guard.js'

export interface ResolvedTarget {
  repo: string
  repoRoot: string
  branch: string
  baseBranch: string
  /** Repo-relative POSIX path of the queried file/dir. */
  file: string
  mode: 'file' | 'symbol'
  /** Qualified Symbol id, present in symbol mode when exactly one matched. */
  symbolId?: string
  /** Set in symbol mode when the qualifier was ambiguous — the CLI lists these. */
  candidates?: SymbolRow[]
  provenance: GitProvenance
  /** True when the repo has no symbols in the graph (suggest `ckn-codegraph`). */
  ungraphed?: boolean
}

export interface SymbolMatch {
  match?: SymbolRow
  candidates?: SymbolRow[]
}

/**
 * Pure symbol matcher. Scopes to `file` (repo-relative) when non-empty, then
 * matches by name:
 *   - exact name (`hello_world`, or the dotted `Foo.method` the extractor stores)
 *   - a bare method name (`method`) against any `*.method`, when the qualifier
 *     itself has no dot.
 * Returns a single `match` when exactly one symbol matches; `candidates` when
 * more than one; an empty object when none. No I/O — the caller supplies the
 * symbol list (real `listSymbols` in prod, a stub in tests).
 */
export function matchSymbol(
  symbols: SymbolRow[],
  file: string,
  qualifier: string,
): SymbolMatch {
  const f = normalizeRel(file)
  const scoped = f ? symbols.filter((s) => normalizeRel(s.file) === f) : symbols
  const bareMethod = !qualifier.includes('.')
  const hits = scoped.filter((s) => {
    if (s.name === qualifier) return true
    if (bareMethod && s.name.endsWith(`.${qualifier}`)) return true
    return false
  })
  if (hits.length === 1) return { match: hits[0] }
  if (hits.length > 1) return { candidates: hits }
  return {}
}

/** Normalize a path to repo-relative POSIX form for comparison. */
function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/** Git toplevel for a path, or '' when not a git repo. */
function gitToplevel(dir: string): string {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

export interface ResolveDeps {
  /** Inject the symbol list source. Defaults to the server `listSymbols` API. */
  listSymbols?: (opts: { repo: string; branch?: string }) => Promise<SymbolRow[]>
  /** Inject git provenance (tests). Defaults to readGitProvenance. */
  readGitProvenance?: (root: string) => GitProvenance
  /** Inject repo-name derivation (tests). Defaults to deriveRepoName. */
  deriveRepoName?: (root: string) => string
  /** Inject git toplevel resolution (tests). */
  gitToplevel?: (dir: string) => string
}

export interface ResolveInput {
  /** A file or directory path (absolute or relative to cwd). */
  path: string
  /** Optional symbol qualifier (`hello_world`, `Foo.method`). */
  symbol?: string
  /** Branch override; defaults to the path's current branch (provenance). */
  branch?: string
  /** Base-branch override; defaults to provenance.baseBranch. */
  base?: string
}

/** Default symbol fetch — the read-only server API (no direct DB open). */
async function fetchSymbols(opts: { repo: string; branch?: string }): Promise<SymbolRow[]> {
  const u = new URL(`${SERVER_URL}/api/graph/symbols`)
  u.searchParams.set('repo', opts.repo)
  if (opts.branch !== undefined) u.searchParams.set('branch', opts.branch)
  u.searchParams.set('limit', '10000')
  const res = await fetch(u)
  if (!res.ok) throw new Error(`listSymbols HTTP ${res.status}`)
  const body = (await res.json()) as { symbols?: SymbolRow[] }
  return Array.isArray(body.symbols) ? body.symbols : []
}

/**
 * Resolve a CLI target. File mode when no symbol is given; symbol mode otherwise
 * (matched via the injected symbol list, file-scoped). Ambiguity returns
 * `candidates`; a not-found symbol returns mode 'symbol' with no `symbolId` (the
 * CLI reports "not found", suggesting `ckn-codegraph <path>` when ungraphed).
 */
export async function resolveTarget(
  input: ResolveInput,
  deps: ResolveDeps = {},
): Promise<ResolvedTarget> {
  const listSyms = deps.listSymbols ?? fetchSymbols
  const readProv = deps.readGitProvenance ?? readGitProvenance
  const deriveName = deps.deriveRepoName ?? deriveRepoName
  const toplevel = deps.gitToplevel ?? gitToplevel

  const abs = path.resolve(input.path)
  if (!existsSync(abs)) throw new Error(`path does not exist: ${abs}`)
  const isDir = statSync(abs).isDirectory()
  const startDir = isDir ? abs : path.dirname(abs)

  const repoRoot = toplevel(startDir) || startDir
  const repo = deriveName(repoRoot)
  const provenance = readProv(repoRoot)
  const branch = input.branch ?? provenance.branch
  const baseBranch = input.base ?? provenance.baseBranch
  const file = normalizeRel(path.relative(repoRoot, abs))

  const base: ResolvedTarget = {
    repo,
    repoRoot,
    branch,
    baseBranch,
    file,
    mode: input.symbol ? 'symbol' : 'file',
    provenance,
  }

  if (!input.symbol) return base

  // Symbol mode — match against the repo's symbols on the resolved branch.
  const symbols = await listSyms({ repo, branch })
  if (symbols.length === 0) base.ungraphed = true
  const m = matchSymbol(symbols, file, input.symbol)
  if (m.match) base.symbolId = m.match.id
  else if (m.candidates && m.candidates.length) base.candidates = m.candidates
  return base
}
