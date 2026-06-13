#!/usr/bin/env tsx
/**
 * codegraph extract → Cortex ingest.
 *
 * Exports `ingestRepo()` (used by the `ckn-codegraph <path>` one-liner) and
 * provides a flag-style CLI:
 *   tsx bin/ckn-codegraph-ingest.ts --repo <name> --root <abspath> [--langs ts,py]
 *
 * It:
 *   1. extracts the AST symbol graph straight from the bundled codegraph
 *      package (importing extractRepo — no temp-file round-trip), and
 *   2. POSTs the snapshot to the running Cortex server's
 *      /api/graph/symbols/upsert so the singular graph stays the one writer
 *      (the server owns the single SQLite writer).
 *
 * codegraph is BUNDLED in-repo at `server/codegraph` (it ships with Cortex —
 * no separate clone). `CKN_CODEGRAPH_PATH` overrides the location for dev. tsx
 * loads its .ts source directly; its deps (ts-morph, web-tree-sitter,
 * tree-sitter-wasms) resolve from this repo's node_modules.
 *
 * API-first, never direct-open the graph DB: this REQUIRES the server to be up
 * (mirrors ckn-bus). If the server is down it fails loud rather than opening the
 * DB (which would contend with the server's writer). Idempotent: re-running
 * re-extracts and upserts; `reExtractedRepos` drives the provable-staleness
 * invalidation so deleted symbols are marked stale on the server side.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isServerUp, SERVER_URL } from './_graph-guard.js'
import { readGitProvenance } from '../server/git/provenance.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Bundled codegraph: <repo>/server/codegraph (CKN_CODEGRAPH_PATH overrides).
const DEFAULT_CODEGRAPH_PATH = path.resolve(__dirname, '..', 'server', 'codegraph')

// Minimal shape of the codegraph extractor we call. Declared locally (rather
// than `typeof import(...)` against codegraph's source) so the dashboard
// typecheck doesn't pull codegraph's .ts-extension internal imports into scope.
interface ExtractedEdge {
  src: string
  dst: string
  kind: string
}
interface ExtractResult {
  symbols: unknown[]
  edges: ExtractedEdge[]
  roots?: Record<string, string>
}
interface CodegraphExtractModule {
  extractRepo(
    root: string,
    opts: { repo: string; langs?: ('ts' | 'py')[]; now: number },
  ): Promise<ExtractResult>
}
interface UpsertResponse {
  symbols: number
  edges: number
  invalidated: number
  repos: string[]
}

export interface IngestResult {
  symbols: number
  edges: number
  invalidated: number
}

/**
 * Extract `root`'s AST graph and upsert it into the running Cortex server.
 * Throws on a missing server or a failed upsert. Progress is logged to stderr.
 */
export async function ingestRepo(opts: {
  repo: string
  root: string
  langs?: string[]
}): Promise<IngestResult> {
  const repo = opts.repo
  const root = path.resolve(opts.root)
  const langs = opts.langs && opts.langs.length ? opts.langs : ['ts', 'py']
  const prov = readGitProvenance(root)

  if (!(await isServerUp())) {
    throw new Error(
      `Cortex server not reachable at ${SERVER_URL}. Ingest is API-only ` +
        `(the server owns the single SQLite writer). Start it with ckn-start and retry.`,
    )
  }

  const codegraphPath = process.env.CKN_CODEGRAPH_PATH ?? DEFAULT_CODEGRAPH_PATH
  const extractMod = (await import(
    path.join(codegraphPath, 'extract', 'index.ts')
  )) as CodegraphExtractModule

  const t0 = Date.now()
  const result = await extractMod.extractRepo(root, {
    repo,
    langs: langs as ('ts' | 'py')[],
    now: Date.now(),
  })
  const extractMs = Date.now() - t0

  const imports = result.edges.filter((e) => e.kind === 'IMPORTS').length
  const extImpl = result.edges.filter(
    (e) => e.kind === 'EXTENDS' || e.kind === 'IMPLEMENTS',
  ).length
  console.error(
    `[codegraph] extracted ${repo}: ${result.symbols.length} symbols, ` +
      `${result.edges.length} edges (${imports} IMPORTS, ${extImpl} EXTENDS/IMPLEMENTS) ` +
      `in ${extractMs}ms from ${root}`,
  )
  console.error(
    `[codegraph] provenance: branch=${prov.branch || '(none)'} ` +
      `commit=${prov.commitSha.slice(0, 8) || '(none)'} dirty=${prov.dirty} base=${prov.baseBranch}`,
  )

  const payload = {
    symbols: result.symbols,
    edges: result.edges,
    reExtractedRepos: [repo],
    repoRoot: result.roots?.[repo] ?? root,
    branch: prov.branch,
    commitSha: prov.commitSha,
    dirty: prov.dirty,
    dirtyFiles: prov.dirtyFiles,
    baseBranch: prov.baseBranch,
  }

  const res = await fetch(`${SERVER_URL}/api/graph/symbols/upsert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`upsert FAILED (HTTP ${res.status}): ${text || res.statusText}`)
  }
  const body = (await res.json()) as UpsertResponse
  console.error(
    `[codegraph] upserted into Cortex: ${body.symbols} symbols, ` +
      `${body.edges} edges, ${body.invalidated} invalidated (stale), ` +
      `repos=[${(body.repos ?? []).join(', ')}]`,
  )
  return { symbols: body.symbols, edges: body.edges, invalidated: body.invalidated }
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0 || i + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing required arg: --${name}`)
  }
  return process.argv[i + 1]!
}

// Flag-style CLI entry. Guarded so importing ingestRepo (from ckn-codegraph.ts)
// does NOT also run this — only run when invoked as the entry script.
const invokedDirectly = (process.argv[1] ?? '').endsWith('ckn-codegraph-ingest.ts')
if (invokedDirectly) {
  ;(async () => {
    const repo = arg('repo')
    const root = arg('root')
    const langs = arg('langs', 'ts,py')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    await ingestRepo({ repo, root, langs })
  })().catch((err) => {
    console.error(`[codegraph-ingest] FAILED: ${err?.message ?? err}`)
    process.exit(1)
  })
}
