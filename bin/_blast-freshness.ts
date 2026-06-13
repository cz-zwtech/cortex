/**
 * On-query freshness gate for blast-radius queries.
 *
 * Compares the queried repo+branch's live git provenance (commitSha + dirty) to
 * the graph's recorded GraphHead. When the working tree is ahead of / dirty vs
 * the graph, it re-ingests that repo+branch (via ingestRepo) BEFORE the query
 * answers — so a blast reflects the code you're actually looking at. The
 * stale/fresh DECISION is a pure function (`decideFreshness`, injected heads +
 * provenance) so it's unit-testable; `ensureFresh` wraps it with the re-ingest,
 * a per-(repo,branch) lockfile (no double-extract under concurrent queries), and
 * the degradation rules.
 *
 * Degradation (never block the query on infra):
 *   - non-git path → 'unknown' (skip freshness, answer the snapshot)
 *   - --no-refresh → 'stale' snapshot (explicit opt-out)
 *   - server down (refresh needed) → throw with ckn-start guidance
 *   - re-ingest fails → 'stale' with the reason in `detail` (answer anyway)
 */
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, openSync, closeSync, rmSync, statSync } from 'node:fs'
import { readGraphHeads as realReadGraphHeads } from '../server/graph/symbols.js'
import { ingestRepo as realIngestRepo, type IngestResult } from './ckn-codegraph-ingest.js'
import { isServerUp as realIsServerUp, SERVER_URL } from './_graph-guard.js'
import type { GraphHeadRow } from '../server/graph/_rows.js'
import type { GitProvenance } from '../server/git/provenance.js'
import type { ResolvedTarget } from './_blast-target.js'

export type FreshnessStatus = 'fresh' | 'refreshed' | 'stale' | 'unknown'

export interface FreshnessResult {
  status: FreshnessStatus
  /** Human-readable note (e.g. the refresh-failure reason). */
  detail?: string
}

/**
 * Pure freshness verdict for a single repo+branch. 'unknown' when the path isn't
 * a git repo (no commit to compare). Otherwise 'fresh' iff a GraphHead exists for
 * the branch, its commit matches, and the tree is clean; 'stale' on a missing
 * head, a commit mismatch, or a dirty tree. Never re-ingests — this is the
 * decision only.
 */
export function decideFreshness(args: {
  heads: GraphHeadRow[]
  provenance: GitProvenance
  branch: string
}): 'fresh' | 'stale' | 'unknown' {
  const { provenance } = args
  if (!provenance.commitSha) return 'unknown' // non-git / unborn branch
  if (provenance.dirty) return 'stale' // uncommitted edits the graph can't have
  const headForBranch = args.heads.find((h) => h.branch === args.branch)
  if (!headForBranch) return 'stale'
  return headForBranch.commitSha === provenance.commitSha ? 'fresh' : 'stale'
}

export interface FreshnessDeps {
  readGraphHeads?: (filter: {
    repo?: string
    branch?: string
    machine?: string
  }) => Promise<GraphHeadRow[]>
  ingestRepo?: (opts: { repo: string; root: string; langs?: string[] }) => Promise<IngestResult>
  isServerUp?: () => Promise<boolean>
  /** Acquire the per-(repo,branch) refresh lock; returns a release fn. */
  acquireLock?: (repo: string, branch: string) => Promise<() => void>
}

const LOCK_DIR = path.join(os.homedir(), '.local', 'state', 'ckn', 'blast-refresh')
const LOCK_TTL_MS = 60_000 // a stale lock older than this is reclaimed
const LOCK_WAIT_MS = 8_000 // how long a loser waits before proceeding stale
const LOCK_POLL_MS = 200

const lockPath = (repo: string, branch: string): string =>
  path.join(LOCK_DIR, `${repo}@${branch || 'default'}.lock`.replace(/[/\\]/g, '_'))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Default lockfile acquire: exclusive-create the lock; if held and fresh, wait
 * (polling) up to LOCK_WAIT_MS then proceed anyway (better a possible double
 * extract than a wedged query); reclaim a lock older than LOCK_TTL_MS. The
 * release fn removes the lock (best-effort).
 */
async function acquireRefreshLock(repo: string, branch: string): Promise<() => void> {
  mkdirSync(LOCK_DIR, { recursive: true })
  const file = lockPath(repo, branch)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(file, 'wx') // exclusive create — fails if held
      closeSync(fd)
      // record holder pid + time (best-effort; not load-bearing)
      try {
        const fd2 = openSync(file, 'w')
        closeSync(fd2)
      } catch {
        /* ignore */
      }
      return () => {
        try {
          rmSync(file, { force: true })
        } catch {
          /* best-effort */
        }
      }
    } catch {
      // held — reclaim if stale, else wait then give up (proceed without lock).
      try {
        const age = Date.now() - statSync(file).mtimeMs
        if (age > LOCK_TTL_MS) {
          rmSync(file, { force: true })
          continue
        }
      } catch {
        continue // vanished between fail and stat — retry create
      }
      if (Date.now() >= deadline) return () => {} // proceed lock-less
      await sleep(LOCK_POLL_MS)
    }
  }
}

/**
 * Ensure the graph is fresh for the target's repo+branch before a query, then
 * report the resulting freshness. Re-ingests on staleness unless `refresh` is
 * false. Degrades per the module contract — only the server-down-while-refresh
 * case throws.
 */
export async function ensureFresh(
  target: ResolvedTarget,
  opts: { refresh?: boolean } = {},
  deps: FreshnessDeps = {},
): Promise<FreshnessResult> {
  const refresh = opts.refresh !== false
  const readHeads = deps.readGraphHeads ?? realReadGraphHeads
  const ingest = deps.ingestRepo ?? realIngestRepo
  const serverUp = deps.isServerUp ?? realIsServerUp
  const acquire = deps.acquireLock ?? acquireRefreshLock

  // Non-git → skip freshness entirely (no server, no head read needed).
  if (!target.provenance.commitSha) return { status: 'unknown' }

  // Reading heads requires the server (CLIs are API-first). If it's not up and
  // we'd need to act, fail with guidance — but a non-refresh request can't act,
  // so still surface the down-server clearly.
  let heads: GraphHeadRow[]
  try {
    heads = await readHeads({ repo: target.repo, branch: target.branch })
  } catch (e: any) {
    if (!(await serverUp())) {
      throw new Error(
        `Cortex server not reachable at ${SERVER_URL}. The blast query is ` +
          `API-first. Start it with ckn-start and retry.`,
      )
    }
    throw e
  }

  const verdict = decideFreshness({ heads, provenance: target.provenance, branch: target.branch })
  if (verdict === 'fresh' || verdict === 'unknown') return { status: verdict }

  // verdict === 'stale'
  if (!refresh) return { status: 'stale', detail: 'refresh disabled (--no-refresh)' }

  if (!(await serverUp())) {
    throw new Error(
      `Cortex server not reachable at ${SERVER_URL}. A refresh is needed but ` +
        `ingest is API-only (the server owns the single writer). Start it with ` +
        `ckn-start and retry, or pass --no-refresh for a (stale) snapshot.`,
    )
  }

  const release = await acquire(target.repo, target.branch)
  try {
    await ingest({ repo: target.repo, root: target.repoRoot })
    return { status: 'refreshed' }
  } catch (e: any) {
    // Never block the query on a failed rebuild — answer the snapshot, flagged.
    return { status: 'stale', detail: `refresh failed: ${e?.message ?? e}` }
  } finally {
    release()
  }
}
