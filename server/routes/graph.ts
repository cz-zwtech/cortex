import { Router } from 'express'
import {
  syncMemories,
  coalesceSync,
  memoryHome,
  queryStats,
  searchEntries,
  getEntry,
  listEntries,
  listScopes,
  listKinds,
  deleteScope,
  pruneStubs,
  pruneOrphanStubs,
  getAllForGraph,
  materializeSimilarityEdges,
} from '../graph/sync.js'
import { triggerTurnSync } from '../graph/turnSync.js'
import { applyLinkageBackfill } from '../migrations.js'
import { importVaultPaths } from '../graph/vaultImport.js'
import { recordImport, listImports, removeImport } from '../importedVaults.js'
import { broadcastEvent } from '../watcher.js'
import { withGraphWriteLock } from '../graph/db.js'
import { findContradictions } from '../graph/contradictions.js'
import {
  upsertSymbols,
  listSymbols,
  getSymbol,
  symbolNeighborhood,
  symbolStats,
  listSymbolGraph,
  listSymbolSubgraph,
  forgetRepoSymbols,
  forgetRepoBranchSymbols,
  symbolBlastRadius,
  symbolBranchDiff,
  readGraphHeads,
  listSymbolViews,
  getRepoDefaultBranch,
  setRepoDefaultBranch,
  SYMBOL_EDGE_TABLES,
  type SymbolEdgeKind,
} from '../graph/symbols.js'
import { mindStatus, persistCodegraphSnapshot, forgetCodegraphSnapshot } from '../privateMind.js'
import { seedOnboardingLocal } from '../onboarding/seed.js'
import { recallForFile } from '../graph/recall.js'
import { similarityEnabled } from '../graph/similarity.js'
import { getEmbeddingMode } from '../embeddings.js'
import { recordSurfacings } from '../graph/surfacings.js'
import {
  OPEN_STATUSES,
  listThreadsWithClaim,
  resumableThreads,
  resolveThreadRef,
  claimThread,
  releaseThread,
  threadClaimState,
  setClaimMode,
  getOpenClaimForSession,
  getThread,
} from '../graph/threads.js'
import { hasReplyTo } from '../graph/bus.js'
import {
  resumeDecision,
  parseWaitingOn,
  evalThreadPredicate,
  evalBusPredicate,
  type PredEval,
} from '../graph/resumeState.js'

export const graphRouter = Router()

// POST /api/graph/contradictions — given candidate similar entry ids (from
// the caller's lock-free vector search) + the new memory's outcome + mentions,
// return the ids it contradicts. Read-only; the caller (ckn-extract SessionEnd
// hook) uses this instead of opening the graph directly, which would
// lock-conflict with the server.
graphRouter.post('/contradictions', async (req, res) => {
  const { similarIds, outcome, mentionsFiles, mentionsTools } = (req.body ?? {}) as {
    similarIds?: unknown
    outcome?: unknown
    mentionsFiles?: unknown
    mentionsTools?: unknown
  }
  try {
    const contradicts = await findContradictions({
      similarIds: Array.isArray(similarIds) ? similarIds.map(String) : [],
      outcome: typeof outcome === 'string' ? outcome : '',
      mentionsFiles: Array.isArray(mentionsFiles) ? mentionsFiles.map(String) : [],
      mentionsTools: Array.isArray(mentionsTools) ? mentionsTools.map(String) : [],
    })
    res.json({ contradicts })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// GET /api/graph/stats — node/edge counts
// POST /api/graph/recall/for-file — ABOUT tier-1 file-knowledge. Body
// { repo?, file, limit? }: surface the memories that mention `file` (a
// repo-relative edit target), ranked by the recall composite. Read-only; the
// PreToolUse ckn-aware hook calls this before an edit. A blank/missing file
// returns { hits: [] } (never an error — the hook must stay quiet, not fail the
// edit). `repo` is accepted for forward-compat but tier-1's join is path-based.
graphRouter.post('/recall/for-file', async (req, res) => {
  const { file, limit, sessionId } = (req.body ?? {}) as {
    file?: unknown
    limit?: unknown
    sessionId?: unknown
  }
  try {
    const target = typeof file === 'string' ? file : ''
    const lim = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : undefined
    const hits = await recallForFile(target, lim !== undefined ? { limit: lim } : {})
    // s1: graph-backed surfacings log — record SURFACED_IN for the file-knowledge
    // hits (same as /api/recall). A caller without a sessionId no-ops gracefully.
    if (typeof sessionId === 'string' && sessionId) {
      recordSurfacings(sessionId, hits.map((h) => h.id), Date.now())
    }
    res.json({ hits })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// GET /api/graph/threads — the s2 resume surface. Query: session (the asking
// session, for claim annotation), owner (machine filter; omit for all),
// resumable=1 (only the resume candidates: open AND not held by a live peer).
// The server owns `now` — claim presence must not depend on the client clock.
// Backs /cortex-threads (default) + /cortex-continue's candidate list (resumable).
graphRouter.get('/threads', (req, res) => {
  try {
    const session = typeof req.query.session === 'string' ? req.query.session : ''
    const owner = typeof req.query.owner === 'string' && req.query.owner ? req.query.owner : undefined
    const now = Date.now()
    const threads =
      req.query.resumable === '1'
        ? resumableThreads(session, now, { ownerMachine: owner })
        : listThreadsWithClaim(session, now, { ownerMachine: owner, statuses: OPEN_STATUSES })
    res.json({ threads })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// POST /api/graph/threads/:id/claim — the write /cortex-continue performs.
// Routes through the server because it owns the single graph writer. Body
// { session }. Idempotent (claimThread no-ops a session's existing open claim).
// Returns the thread detail (next_step/links) + the resulting claim state, or
// 404 for a missing/non-thread id.
graphRouter.post('/threads/:id/claim', (req, res) => {
  try {
    const { session } = (req.body ?? {}) as { session?: unknown }
    const sid = typeof session === 'string' ? session : ''
    if (!sid) return res.status(400).json({ error: 'session required' })
    // Resolve the ref (exact id, bare slug, entryId suffix, or name) so
    // /cortex-continue works with whatever the user typed — then claim the
    // RESOLVED id, never the raw param.
    const thread = resolveThreadRef(req.params.id)
    if (!thread) return res.status(404).json({ error: `no thread ${req.params.id}` })
    const now = Date.now()
    claimThread(thread.id, sid, now)
    res.json({ thread, claimState: threadClaimState(thread.id, sid, now) })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// POST /api/graph/threads/:id/release — graceful hand-off (s2b). A live session
// frees its own claim on a thread so a peer can resume it IMMEDIATELY, without
// waiting for the holder to go stale or sign off. Append-only lineage
// (releaseThread sets released_at; the row stays). Body { session }; resolves a
// bare ref like claim. Returns the thread + resulting claim state.
graphRouter.post('/threads/:id/release', (req, res) => {
  try {
    const { session } = (req.body ?? {}) as { session?: unknown }
    const sid = typeof session === 'string' ? session : ''
    if (!sid) return res.status(400).json({ error: 'session required' })
    const thread = resolveThreadRef(req.params.id)
    if (!thread) return res.status(404).json({ error: `no thread ${req.params.id}` })
    const now = Date.now()
    releaseThread(thread.id, sid, now)
    res.json({ thread, claimState: threadClaimState(thread.id, sid, now) })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// POST /api/graph/threads/:id/mode — set the work mode on this session's OPEN claim
// (mode-on-claim, #89). Body { session, mode }. The session declares its mode AT the
// transition (starts waiting / resumes / quiesces) so PostCompact can re-evaluate it.
graphRouter.post('/threads/:id/mode', (req, res) => {
  try {
    const { session, mode } = (req.body ?? {}) as { session?: unknown; mode?: unknown }
    const sid = typeof session === 'string' ? session : ''
    const m = typeof mode === 'string' ? mode : ''
    if (!sid || !m) return res.status(400).json({ error: 'session and mode required' })
    const thread = resolveThreadRef(req.params.id)
    if (!thread) return res.status(404).json({ error: `no thread ${req.params.id}` })
    setClaimMode(thread.id, sid, m)
    res.json({ thread: thread.id, mode: m })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// GET /api/graph/resume-state?session=<id> — PostCompact resume verdict (#89). Restores the
// mandate (the session's open claim) but RE-EVALUATES a waiting-on predicate from ground
// truth; anything missing / unparseable / unknowable → ambiguous (safe). The caller
// (ckn-context on source=compact) resolves self-id, then renders the head + announces.
graphRouter.get('/resume-state', (req, res) => {
  try {
    const session = String(req.query.session ?? '')
    const claim = session ? getOpenClaimForSession(session) : null
    if (!claim) return res.json({ verdict: 'ambiguous', reason: session ? 'no-open-claim' : 'no-session' })
    let predEval: PredEval | null = null
    if (claim.mode.startsWith('waiting-on:')) {
      const pred = parseWaitingOn(claim.mode)
      if (!pred) predEval = 'unknowable'
      else if (pred.kind === 'thread') {
        const t = getThread(pred.threadId)
        predEval = evalThreadPredicate(
          { status: pred.status },
          t ? { found: true, status: t.state.status } : { found: false },
        )
      } else {
        predEval = evalBusPredicate(hasReplyTo(pred.msgId))
      }
    }
    const verdict = resumeDecision({ selfIdResolved: true, mode: claim.mode, predEval })
    res.json({ verdict, threadId: claim.threadId, mode: claim.mode })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

graphRouter.get('/stats', async (_req, res) => {
  try {
    const stats = await queryStats()
    res.json(stats)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/graph/sync — trigger a full sync from memory files
graphRouter.post('/sync', async (_req, res) => {
  try {
    // Coalesce concurrent syncs (commit-1 c): N sessions stopping near-together
    // share one in-flight pass + a single trailing run instead of queuing N full
    // passes behind the write lock.
    const result = await coalesceSync(() =>
      withGraphWriteLock('sync', () => syncMemories(memoryHome())),
    )
    // Tell every WS client (incl. the Sessions view's right rail) that the
    // graph just changed, so they can pull fresh stats / recent-write entries.
    broadcastEvent({ type: 'graph:sync', source: 'memory', result })
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/graph/sync/turn — silent-layer turn cadence (#111). ENQUEUES a local md→graph
// fold and FAST-ACKs; the heavy fold runs async server-side, and an in-memory change-guard
// skips a no-change turn for free. LOCAL ONLY — never the remote/mind-sync path. The
// caller (ckn-pause-context) awaits only this quick ack, so it can't block or drop the run.
graphRouter.post('/sync/turn', (_req, res) => {
  const fold = () =>
    coalesceSync(() => withGraphWriteLock('turn-sync', () => syncMemories(memoryHome()))).then((result) => {
      broadcastEvent({ type: 'graph:sync', source: 'turn', result })
      return result
    })
  const decision = triggerTurnSync(fold, Date.now())
  res.status(decision === 'fold' ? 202 : 200).json({ status: decision === 'fold' ? 'enqueued' : decision })
})

// GET /api/graph/search?q=... — full-text search across entries
graphRouter.get('/search', async (req, res) => {
  const q = (req.query.q as string) ?? ''
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
  if (!q.trim()) return res.json({ entries: [] })
  try {
    const entries = await searchEntries(q, limit)
    res.json({ entries })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/graph/nodes?kind=...&scope=...&since=<ms>&syncedSince=<ms>&sort=updated|synced
graphRouter.get('/nodes', async (req, res) => {
  const kind = req.query.kind as string | undefined
  const scope = req.query.scope as string | undefined
  const since = req.query.since ? parseInt(req.query.since as string) : undefined
  const syncedSince = req.query.syncedSince ? parseInt(req.query.syncedSince as string) : undefined
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000)
  const sort = (req.query.sort as string) === 'synced' ? 'synced' : 'updated'
  const machine = req.query.machine ? String(req.query.machine) : undefined
  try {
    const entries = await listEntries(kind, since, limit, sort, syncedSince, scope, machine)
    res.json({ entries })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/graph/scopes — every distinct scope with its entry count
graphRouter.get('/scopes', async (_req, res) => {
  try {
    const scopes = await listScopes()
    res.json({ scopes })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/graph/kinds — every distinct kind with its entry count
graphRouter.get('/kinds', async (_req, res) => {
  try {
    const kinds = await listKinds()
    res.json({ kinds })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/graph/prune-stubs — one-time cleanup of empty wikilink concept
// nodes left over from prior sync/vault-import versions. Real entries are
// untouched; only `scope='vault' AND content=''` rows are removed.
graphRouter.post('/prune-stubs', async (_req, res) => {
  try {
    const removed = await withGraphWriteLock('prune-stubs', () => pruneStubs())
    if (removed > 0) {
      broadcastEvent({ type: 'graph:sync', source: 'prune-stubs', removed })
    }
    res.json({ removed })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/graph/seed-onboarding — seed the bundled onboarding corpus into the
// local graph under scope `shared:cortex`. No remote / team-mind required;
// idempotent (stable ids upsert). The "encapsulated in the repo" delivery path.
graphRouter.post('/seed-onboarding', async (_req, res) => {
  try {
    const result = await withGraphWriteLock('seed-onboarding', () => seedOnboardingLocal())
    broadcastEvent({ type: 'graph:sync', source: 'seed-onboarding', seeded: result.seeded })
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// POST /api/graph/prune-orphans — remove orphan stub nodes (content='' AND no
// relationships). Set-based: O(edges) endpoint projection + a single content=''
// scan, never a per-node optional-expand. Serialized through the write lock.
graphRouter.post('/prune-orphans', async (_req, res) => {
  try {
    const removed = await withGraphWriteLock('prune-orphans', () => pruneOrphanStubs())
    if (removed > 0) {
      broadcastEvent({ type: 'graph:sync', source: 'prune-orphans', removed })
    }
    res.json({ removed })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/graph/linkage-backfill — run the memory→file linkage backfill ("0009")
// on demand (idempotent; same code as boot). Serialized through the write lock so
// it doesn't contend with sync. Referential-only triage — never removes a memory.
graphRouter.post('/linkage-backfill', async (_req, res) => {
  try {
    const result = await withGraphWriteLock('linkage-backfill', () => applyLinkageBackfill(true))
    if (result && (result.edgesCreated > 0 || result.removed > 0)) {
      broadcastEvent({ type: 'graph:sync', source: 'linkage-backfill', removed: result.removed })
    }
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/graph/scope/:scope — purge all entries under the given scope
graphRouter.delete('/scope/:scope(*)', async (req, res) => {
  try {
    const removed = await withGraphWriteLock('delete-scope', () => deleteScope(req.params.scope!))
    broadcastEvent({ type: 'graph:sync', source: 'delete-scope', scope: req.params.scope, removed })
    res.json({ removed })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/graph/import-vault  { vaultName, targets: string[] }
graphRouter.post('/import-vault', async (req, res) => {
  const { vaultName, targets } = req.body
  if (!vaultName || !Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'vaultName and targets[] required' })
  }
  try {
    const result = await withGraphWriteLock('import-vault', () => importVaultPaths(vaultName, targets))
    // Persist the import so syncMemories can replay it after a graph.db
    // wipe. Without this, deleting graph.db would lose vault entries
    // since their .md files live in the user's Obsidian vault, not in
    // ~/.claude/memory/.
    await recordImport(vaultName, targets)
    broadcastEvent({ type: 'graph:sync', source: 'vault-import', vaultName, result })
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/graph/imported-vaults — list recorded vault imports
graphRouter.get('/imported-vaults', async (_req, res) => {
  try {
    res.json({ vaults: await listImports() })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/graph/imported-vaults/:vaultName — drop a recorded import
graphRouter.delete('/imported-vaults/:vaultName', async (req, res) => {
  try {
    await removeImport(req.params.vaultName)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/graph/all — all nodes + edges for force graph visualization
graphRouter.get('/all', async (_req, res) => {
  try {
    const data = await getAllForGraph()
    res.json(data)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/graph/similarity/rebuild — #127: recompute ALL kNN SIMILAR_TO edges from the
// embedding sidecar. The incremental sync pass only recomputes changed sources, so a
// neighbour's top-K can go stale when an unrelated entry changes; this full rebuild heals
// that bounded drift (and bootstraps the edges when the feature is first enabled). No-op
// when similarity is disabled (embeddings off or CKN_SIMILARITY=off).
graphRouter.post('/similarity/rebuild', async (_req, res) => {
  try {
    if (!similarityEnabled(getEmbeddingMode())) {
      res.json({ ok: false, reason: 'similarity disabled (embeddings off or CKN_SIMILARITY=off)' })
      return
    }
    const result = await withGraphWriteLock('similarity-rebuild', () => materializeSimilarityEdges(null))
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/graph/node/:id — single node with links + backlinks
// POST /api/graph/symbols/upsert — ingest a codegraph JSON snapshot.
// Body: { symbols: [...], edges: [...], reExtractedRepos?: string[] }.
// Serialized through the write lock; pure graph writes only (the extraction —
// git/AST/network work — happens in the codegraph package before the POST).
graphRouter.post('/symbols/upsert', async (req, res) => {
  const body = (req.body ?? {}) as {
    symbols?: unknown
    edges?: unknown
    reExtractedRepos?: unknown
    repoRoot?: unknown
    branch?: unknown
    commitSha?: unknown
    dirty?: unknown
    dirtyFiles?: unknown
    baseBranch?: unknown
  }
  if (!Array.isArray(body.symbols) || !Array.isArray(body.edges)) {
    return res.status(400).json({ error: 'symbols[] and edges[] required' })
  }
  try {
    const result = await withGraphWriteLock('symbols-upsert', () =>
      upsertSymbols(
        { symbols: body.symbols as any[], edges: body.edges as any[] },
        {
          reExtractedRepos: Array.isArray(body.reExtractedRepos)
            ? body.reExtractedRepos.map(String)
            : undefined,
          repoRoot: typeof body.repoRoot === 'string' ? body.repoRoot : undefined,
          branch: typeof body.branch === 'string' ? body.branch : undefined,
          commitSha: typeof body.commitSha === 'string' ? body.commitSha : undefined,
          dirty: body.dirty === true,
          dirtyFiles: typeof body.dirtyFiles === 'string' ? body.dirtyFiles : undefined,
          baseBranch: typeof body.baseBranch === 'string' ? body.baseBranch : undefined,
        },
      ),
    )
    broadcastEvent({ type: 'graph:sync', source: 'symbols', result })
    // When private-mind is enabled, persist the snapshot as the canonical,
    // regenerable codegraph/<repo>/graph.json artifact so mind-sync federates
    // the AST graph across the user's machines. Best-effort, fs-only, off the
    // graph lock — never fails the ingest. One repo per POST (extraction is
    // per-repo); derive the repo from reExtractedRepos, else the upsert result.
    try {
      if ((await mindStatus()).enabled) {
        const repo =
          Array.isArray(body.reExtractedRepos) && body.reExtractedRepos[0]
            ? String(body.reExtractedRepos[0])
            : result.repos[0]
        if (repo) {
          await persistCodegraphSnapshot(repo, {
            symbols: body.symbols as unknown[],
            edges: body.edges as unknown[],
          })
        }
      }
    } catch {
      /* persist is best-effort; the graph ingest already succeeded */
    }
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// POST /api/graph/symbols/forget { repo, branch?, machine? } — forget a repo's
// symbol subgraph. OMIT `branch` → the WHOLE repo (all branches) + tombstone
// the federated codegraph/<repo>/graph.json so the removal propagates. INCLUDE
// `branch` (any string, INCLUDING "" — the unstamped/pre-lineage coordinate) →
// only that (repo, branch[, machine]) snapshot, leaving the live branch intact;
// local-only (no federation tombstone). Scope is decided by the KEY's presence,
// not its truthiness, so `branch: ""` prunes the empty coordinate rather than
// (footgun) nuking the whole repo.
graphRouter.post('/symbols/forget', async (req, res) => {
  const repo = typeof req.body?.repo === 'string' ? req.body.repo.trim() : ''
  if (!repo) return res.status(400).json({ error: 'repo required' })
  const branchGiven = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'branch')
  const machine =
    typeof req.body?.machine === 'string' && req.body.machine.trim() ? req.body.machine.trim() : undefined
  try {
    if (branchGiven) {
      if (typeof req.body.branch !== 'string')
        return res.status(400).json({ error: 'branch must be a string' })
      const branch = req.body.branch // may be "" — the unstamped coordinate
      const removed = await withGraphWriteLock('symbols-forget-branch', () =>
        forgetRepoBranchSymbols(repo, branch, machine),
      )
      broadcastEvent({ type: 'graph:sync', source: 'symbols-forget-branch', repo, removed })
      return res.json({ removed, branch, federated: false })
    }
    const removed = await withGraphWriteLock('symbols-forget', () => forgetRepoSymbols(repo))
    let federated = false
    try {
      if ((await mindStatus()).enabled) {
        federated = await forgetCodegraphSnapshot(repo)
      }
    } catch {
      /* federation forget is best-effort; the local forget already succeeded */
    }
    broadcastEvent({ type: 'graph:sync', source: 'symbols-forget', repo, removed })
    res.json({ removed, federated })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// POST /api/graph/symbols/blast { repo, paths: [...], kinds?: [...] } — targeted
// blast-radius: symbols defined in the given files + their cross-file dependents,
// server-side filtered (no whole-graph transfer). For consumers (e.g. the swarm)
// that need "who depends on the functions in this ticket's touched files".
graphRouter.post('/symbols/blast', async (req, res) => {
  const body = (req.body ?? {}) as {
    repo?: unknown; paths?: unknown; kinds?: unknown
    branch?: unknown; baseBranch?: unknown; machine?: unknown
  }
  const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
  const paths = Array.isArray(body.paths) ? body.paths.map(String).filter(Boolean) : []
  if (!repo || paths.length === 0) {
    return res.status(400).json({ error: 'repo and paths[] required' })
  }
  const kinds = Array.isArray(body.kinds)
    ? body.kinds
        .map((k) => String(k).trim().toUpperCase())
        .filter((k): k is SymbolEdgeKind => (SYMBOL_EDGE_TABLES as readonly string[]).includes(k))
    : undefined
  try {
    res.json(
      await symbolBlastRadius(repo, paths, kinds, {
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        baseBranch: typeof body.baseBranch === 'string' ? body.baseBranch : undefined,
        machine: typeof body.machine === 'string' ? body.machine : undefined,
      }),
    )
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// GET /api/graph/symbols?repo=...&limit=... — list symbols (read-only).
graphRouter.get('/symbols', async (req, res) => {
  try {
    const repo = req.query.repo as string | undefined
    const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined
    const machine = req.query.machine ? String(req.query.machine) : undefined
    const branch = req.query.branch !== undefined ? String(req.query.branch) : undefined
    const symbols = await listSymbols({ repo, limit, machine, branch })
    res.json({ symbols })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// GET /api/graph/symbols/stats — symbol/edge counts + per-repo breakdown.
graphRouter.get('/symbols/stats', async (_req, res) => {
  try {
    res.json(await symbolStats())
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// GET /api/graph/symbols/graph?repo=... — the full symbol graph as
// { nodes, edges } for the D3 force canvas (memory-graph overlay). MUST be
// registered before the /symbols/:id(*) wildcard so "graph" isn't swallowed.
graphRouter.get('/symbols/graph', async (req, res) => {
  // When no ?branch is passed, listSymbolGraph resolves the repo's real base
  // from GraphHead.baseBranch (defaultBaseBranch) — so a repo whose base is
  // 'develop' no longer renders empty. Floors at 'main' when repo is absent.
  try {
    const repo = req.query.repo as string | undefined
    const machine = req.query.machine ? String(req.query.machine) : undefined
    const branch = req.query.branch !== undefined ? String(req.query.branch) : undefined
    res.json(await listSymbolGraph({ repo, machine, branch }))
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// GET /api/graph/symbols/subgraph?repo=&branch=&machine=&topN=&mode= — capped,
// branch-resolved, optionally module-aggregated subgraph for the Code-view
// empty-state visualization. MUST be registered before the /symbols/:id(*)
// wildcard so "subgraph" isn't swallowed.
graphRouter.get('/symbols/subgraph', async (req, res) => {
  const repo = req.query.repo ? String(req.query.repo) : ''
  if (!repo) return res.status(400).json({ error: 'repo required' })
  const branch = req.query.branch !== undefined ? String(req.query.branch) : undefined
  const machine = req.query.machine ? String(req.query.machine) : undefined
  const topN = req.query.topN ? parseInt(req.query.topN as string) : undefined
  const m = String(req.query.mode ?? 'symbols')
  const mode = m === 'modules' || m === 'all' ? m : 'symbols'
  try {
    res.json(await listSymbolSubgraph({ repo, branch, machine, topN, mode }))
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// GET /api/graph/heads?repo&branch&machine — GraphHead freshness rows
// ("is the graph fresh for me?"). A consumer compares commitSha to its live
// `git rev-parse HEAD` and learns same-commit / behind / different-branch.
graphRouter.get('/heads', async (req, res) => {
  try {
    const repo = req.query.repo ? String(req.query.repo) : undefined
    const branch = req.query.branch !== undefined ? String(req.query.branch) : undefined
    const machine = req.query.machine ? String(req.query.machine) : undefined
    res.json({ heads: await readGraphHeads({ repo, branch, machine }) })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// GET /api/graph/symbols/views — distinct (repo,branch,machine) coordinates
// with counts + freshness. Drives "pick another swarm's / machine's view".
graphRouter.get('/symbols/views', async (_req, res) => {
  try {
    res.json({ views: await listSymbolViews() })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// GET /api/graph/symbols/default-branch?repo= — the user-pinned Code-view
// display branch for a repo (or null). Registered before /symbols/:id(*).
graphRouter.get('/symbols/default-branch', (req, res) => {
  const repo = req.query.repo !== undefined ? String(req.query.repo) : ''
  res.json({ repo, branch: getRepoDefaultBranch(repo) })
})

// POST /api/graph/symbols/default-branch { repo, branch } — pin the display
// branch; a falsy/absent branch clears the pin (revert to auto-resolution).
graphRouter.post('/symbols/default-branch', (req, res) => {
  const body = (req.body ?? {}) as { repo?: unknown; branch?: unknown }
  const repo = typeof body.repo === 'string' ? body.repo : ''
  if (!repo) return res.status(400).json({ error: 'repo required' })
  const branch = typeof body.branch === 'string' && body.branch ? body.branch : null
  setRepoDefaultBranch(repo, branch, Date.now())
  res.json({ repo, branch })
})

// GET /api/graph/symbols/branch-diff?repo=&a=&b=&base= — graph branch-diff.
// Compares two branches' symbol sets keyed by naturalId and predicts COMPETING
// changes (touched on both vs the common base) before a text-level merge
// conflict. MUST be registered before the /symbols/:id(*) wildcard so
// "branch-diff" isn't swallowed.
graphRouter.get('/symbols/branch-diff', async (req, res) => {
  try {
    const repo = req.query.repo ? String(req.query.repo) : ''
    const a = req.query.a ? String(req.query.a) : ''
    const b = req.query.b ? String(req.query.b) : ''
    if (!repo || !a || !b) {
      return res.status(400).json({ error: 'repo, a, and b are required' })
    }
    const base = req.query.base !== undefined ? String(req.query.base) : undefined
    const machine = req.query.machine ? String(req.query.machine) : undefined
    res.json(await symbolBranchDiff(repo, a, b, { base, machine }))
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// GET /api/graph/symbols/:id(*)/dependents — blast-radius query. Returns the
// symbol plus its dependents (who calls/imports it) and dependencies.
// Optional ?kinds=CALLS,IMPORTS filters the edge tables traversed.
graphRouter.get('/symbols/:id(*)/dependents', async (req, res) => {
  try {
    const kindsParam = (req.query.kinds as string | undefined)
      ?.split(',')
      .map((k) => k.trim().toUpperCase())
      .filter((k): k is SymbolEdgeKind =>
        (SYMBOL_EDGE_TABLES as readonly string[]).includes(k),
      )
    const result = await symbolNeighborhood(req.params.id!, kindsParam)
    if (!result.symbol) return res.status(404).json({ error: 'not found' })
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// GET /api/graph/symbols/:id(*) — single symbol node.
graphRouter.get('/symbols/:id(*)', async (req, res) => {
  try {
    const symbol = await getSymbol(req.params.id!)
    if (!symbol) return res.status(404).json({ error: 'not found' })
    res.json(symbol)
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

graphRouter.get('/node/:id(*)', async (req, res) => {
  const id = req.params.id!
  try {
    const entry = await getEntry(id)
    if (!entry) return res.status(404).json({ error: 'not found' })
    res.json(entry)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})
