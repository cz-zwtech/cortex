/**
 * Codegraph cache: a file the PreToolUse hook reads to decide — in
 * microseconds, no network — whether an edited file lives in a graphed repo.
 * Mirrors awareCache.ts. Lists each graphed repo with the absolute root the
 * extractor walked (Symbol.root), so the hook can map an edited file path to
 * (repo, repo-relative path). Repos with no stored root are omitted (the hook
 * can't resolve files for them).
 *
 * Refreshed by the server on every `graph:sync` event + at boot. Has a TTL so
 * out-of-band graph edits eventually propagate even without an event.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { all } from './graph/db.js'

const CACHE_PATH = path.join(os.homedir(), '.local', 'state', 'ckn', 'codegraph-cache.json')
export const CODEGRAPH_CACHE_TTL_MS = 10 * 60 * 1000

export interface CodegraphRepo {
  repo: string
  root: string
}
export interface CodegraphCache {
  repos: CodegraphRepo[]
  generatedAt: number
}

/** Pure read + JSON write (test seam — cachePath is overridable). Reads the
 * SQLite graph directly via the db.ts singleton; no connection param. */
export async function __refreshCodegraphCacheOn(
  cachePath: string = CACHE_PATH,
): Promise<CodegraphCache> {
  const res = all<{ repo: string; root: string; c: number }>(
    `SELECT repo AS repo, root AS root, count(*) AS c FROM symbols ` +
      `WHERE root <> '' ` +
      `GROUP BY repo, root ` +
      `ORDER BY c DESC`,
  )
  const seen = new Set<string>()
  const repos: CodegraphRepo[] = []
  for (const r of res) {
    const repo = String(r.repo ?? '')
    const root = String(r.root ?? '')
    if (!repo || !root || seen.has(repo)) continue
    seen.add(repo)
    repos.push({ repo, root })
  }
  const cache: CodegraphCache = { repos, generatedAt: Date.now() }
  await fs.mkdir(path.dirname(cachePath), { recursive: true })
  await fs.writeFile(cachePath, JSON.stringify(cache), 'utf-8')
  return cache
}

/** Production entry — reads the server's singleton SQLite handle. */
export async function refreshCodegraphCache(): Promise<CodegraphCache> {
  return __refreshCodegraphCacheOn()
}

/** Hook-side read. Returns null on miss/parse error (hook then no-ops). */
export async function readCodegraphCache(): Promise<CodegraphCache | null> {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf-8')
    const c = JSON.parse(raw) as CodegraphCache
    if (!Array.isArray(c.repos) || typeof c.generatedAt !== 'number') return null
    return c
  } catch {
    return null
  }
}
