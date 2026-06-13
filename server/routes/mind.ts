import { Router } from 'express'
import {
  mindSync,
  ensureClone,
  mindStatus,
  detectDuplicates,
  changedLocalPaths,
  readCodegraphSnapshot,
  readProfileSnapshot,
} from '../privateMind.js'
import { withGraphWriteLock } from '../graph/db.js'
import { syncMemories, memoryHome } from '../graph/sync.js'
import { upsertSymbols, forgetRepoSymbols } from '../graph/symbols.js'
import { importProfileSnapshot } from '../graph/profile.js'
import { broadcastEvent } from '../watcher.js'

export const mindRouter = Router()

// GET /api/mind/status — is private-mind enabled, and the configured remote.
mindRouter.get('/status', async (_req, res) => {
  try {
    res.json(await mindStatus())
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// POST /api/mind/enable  { remote } — clone/configure the private-mind repo.
mindRouter.post('/enable', async (req, res) => {
  const remote = typeof req.body?.remote === 'string' ? req.body.remote.trim() : ''
  if (!remote) return res.status(400).json({ error: 'remote required' })
  try {
    const { freshlyCloned } = await ensureClone(remote)
    // freshlyCloned lets the CLI tell the first sync to skip the redundant worktree
    // fetch (origin/main already current from the clone — #97) and report the
    // first-clone corpus count (#96).
    res.json({ ...(await mindStatus()), freshlyCloned })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// POST /api/mind/sync — full bidirectional reconcile, then re-index the graph.
// mindSync does git (network) + filesystem only and serializes itself —
// it must NOT run under the graph write lock, or a hung git push would
// starve every /api/graph/sync (that bug wedged the server). Only the
// post-reconcile graph re-index takes the graph write lock.
mindRouter.post('/sync', async (req, res) => {
  try {
    // #97: the CLI sets skipWorktreeFetch right after a fresh clone so the first
    // sync drops the redundant (and altssh-race-prone) worktree fetch.
    const skipWorktreeFetch = req.body?.skipWorktreeFetch === true
    const report = await mindSync({ skipWorktreeFetch })
    if (report.enabled) {
      // Fold the reconciled .md files into the local graph (single writer = us).
      await withGraphWriteLock('mind-reindex', () => syncMemories(memoryHome()))
      // Replay adopted codegraph snapshots into the graph so a machine that pulled
      // the mind but lacks the source repo still gets the AST graph. The read
      // is off-lock (filesystem); only the upsert takes the graph write lock —
      // mirrors the memory re-index sequencing. reExtractedRepos clears symbols
      // that vanished from the snapshot (provable staleness). Idempotent.
      report.codegraphReplayed = []
      for (const repo of report.codegraphAdopted) {
        const snap = await readCodegraphSnapshot(repo)
        if (!snap) continue
        const r = await withGraphWriteLock('codegraph-replay', () =>
          upsertSymbols(snap, { reExtractedRepos: [repo] }),
        )
        report.codegraphReplayed.push({
          repo,
          symbols: r.symbols,
          edges: r.edges,
          invalidated: r.invalidated,
        })
      }
      // A peer forgot these repos (codegraph tombstone propagated). Mirror the
      // removal in our local graph. Idempotent — no-op if already absent.
      for (const repo of report.codegraphForgotten) {
        await withGraphWriteLock('codegraph-forget', () => forgetRepoSymbols(repo))
      }
      // Replay the adopted human-profile snapshot into the graph. Read is off-lock
      // (filesystem); the merge takes the graph write lock. importProfileSnapshot
      // unions cross-machine evidence by competing_group, so this is idempotent.
      if (report.profileAdopted) {
        const snap = await readProfileSnapshot()
        if (snap) await withGraphWriteLock('profile-replay', async () => importProfileSnapshot(snap))
      }
      // Non-destructive dedup detection over what changed this run.
      report.duplicates = await detectDuplicates(changedLocalPaths(report))
      broadcastEvent({ type: 'graph:sync', source: 'mind-sync' })
    }
    res.json(report)
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// POST /api/mind/profile/replay — FORCE-replay the local profile.json snapshot
// into the graph, unconditionally (independent of sync's profileAdopted gate).
// For recovering a node whose graph profile is empty even though its private-mind
// clone holds a rich profile.json — e.g. its localBase already advanced past the
// (formerly empty) snapshot, so a plain sync skips the replay. Guards against
// replaying an empty snapshot (would clobber nothing into the graph).
// importProfileSnapshot unions evidence by competing_group, so this is idempotent.
mindRouter.post('/profile/replay', async (_req, res) => {
  try {
    const snap = await readProfileSnapshot()
    if (!snap || (snap.facets.length === 0 && !snap.narrative.trim())) {
      return res.json({ replayed: false, reason: 'no non-empty profile.json to replay' })
    }
    await withGraphWriteLock('profile-replay-force', async () => importProfileSnapshot(snap))
    broadcastEvent({ type: 'graph:sync', source: 'profile-replay-force' })
    res.json({ replayed: true, facets: snap.facets.length, narrativeLen: snap.narrative.length })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})
