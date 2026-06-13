#!/usr/bin/env tsx
/**
 * ckn-mind-sync — sync this machine's Cortex memories with the private-mind
 * git repo (the singular mind across your own machines). See
 * docs/cortex-private-mind-sync.md.
 *
 * Opt-in: does nothing until enabled with --remote once. Disabled by default
 * (community-safe). Honors CKN_PRIVATE_MIND=off.
 *
 * Usage:
 *   ckn-mind-sync --remote git@github.com:<you>/private-cortex.git   # enable
 *   ckn-mind-sync                                                    # sync
 *   ckn-mind-sync --status
 *
 * API-first (the server owns the single SQLite writer for the post-sync
 * re-index); falls back to direct only when no server is bound.
 */
import { SERVER_URL, isServerUp } from './_graph-guard.js'
import { syncEngagementBlock } from './ckn-engagement.js'

interface MindSyncReport {
  enabled: boolean
  reason?: string
  pulled: boolean
  pushed: boolean
  adopted: string[]
  pushedFiles: string[]
  conflicts: string[]
  deletedLocal: string[]
  tombstoned: string[]
  resurrected: string[]
  duplicates: { id: string; near: string; score: number }[]
  codegraphAdopted: string[]
  codegraphReplayed?: { repo: string; symbols: number; edges: number; invalidated: number }[]
  codegraphForgotten?: string[]
  errors: string[]
}

const parseArgs = () => {
  const argv = process.argv.slice(2)
  let remote: string | null = null
  let statusOnly = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--remote') remote = argv[++i] ?? null
    else if (a === '--status') statusOnly = true
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage:\n' +
          '  ckn-mind-sync --remote <git-url>   # enable (clone/configure once)\n' +
          '  ckn-mind-sync                      # bidirectional sync\n' +
          '  ckn-mind-sync --status             # show enabled state + remote',
      )
      process.exit(0)
    }
  }
  return { remote, statusOnly }
}

const reportText = (r: MindSyncReport): string => {
  if (!r.enabled) return `[ckn-mind] disabled — ${r.reason ?? 'not configured'}`
  const lines = [
    `[ckn-mind] sync complete (pulled=${r.pulled} pushed=${r.pushed})`,
    `  adopted from remote: ${r.adopted.length}`,
    `  pushed to remote:    ${r.pushedFiles.length}`,
    `  conflicts (kept both): ${r.conflicts.length}${r.conflicts.length ? ' → ' + r.conflicts.slice(0, 5).join(', ') : ''}`,
    `  deleted locally:     ${r.deletedLocal.length}`,
    `  deletes propagated:  ${r.tombstoned.length}`,
    `  resurrected:         ${r.resurrected.length}`,
  ]
  if (r.codegraphReplayed?.length) {
    lines.push(`  codegraph replayed into graph: ${r.codegraphReplayed.length} repo(s)`)
    for (const c of r.codegraphReplayed)
      lines.push(`    ${c.repo}: ${c.symbols} symbols, ${c.edges} edges${c.invalidated ? `, ${c.invalidated} stale` : ''}`)
  } else if (r.codegraphAdopted.length) {
    lines.push(`  codegraph adopted (replay pending): ${r.codegraphAdopted.join(', ')}`)
  }
  if (r.codegraphForgotten?.length) {
    lines.push(`  codegraph forgotten (peer removed): ${r.codegraphForgotten.join(', ')}`)
  }
  if (r.duplicates.length) {
    lines.push(`  possible duplicates (detection only): ${r.duplicates.length}`)
    for (const d of r.duplicates.slice(0, 5)) lines.push(`    ${d.id} ≈ ${d.near} (${d.score})`)
  }
  if (r.errors.length) lines.push(`  errors: ${r.errors.join('; ')}`)
  return lines.join('\n')
}

const main = async () => {
  const { remote, statusOnly } = parseArgs()
  const serverUp = await isServerUp()

  // --remote: enable. Prefer the server endpoint when up (it owns the dir);
  // otherwise call the module directly. `freshlyCloned` (a clone just happened this
  // run) tells the first sync below to SKIP the redundant worktree fetch (#97).
  let freshlyCloned = false
  if (remote) {
    if (serverUp) {
      const res = await fetch(`${SERVER_URL}/api/mind/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        console.error(`[ckn-mind] enable failed: ${(data as any).error ?? res.status}`)
        process.exit(1)
      }
      freshlyCloned = Boolean((data as any).freshlyCloned)
      console.log(`[ckn-mind] enabled — remote ${(data as any).remote ?? remote}`)
      if (freshlyCloned && typeof (data as any).memories === 'number') {
        console.log(`[ckn-mind] cloned your mind — ${(data as any).memories} memories adopted on first clone`)
      }
    } else {
      const { ensureClone, mindStatus } = await import('../server/privateMind.js')
      const r = await ensureClone(remote)
      freshlyCloned = r.freshlyCloned
      const st = await mindStatus()
      console.log(`[ckn-mind] enabled — remote ${st.remote ?? remote}`)
      if (freshlyCloned && typeof st.memories === 'number') {
        console.log(`[ckn-mind] cloned your mind — ${st.memories} memories adopted on first clone`)
      }
    }
    if (statusOnly) return
  }

  if (statusOnly) {
    const st = serverUp
      ? await (await fetch(`${SERVER_URL}/api/mind/status`)).json().catch(() => ({}))
      : await (await import('../server/privateMind.js')).mindStatus()
    console.log('[ckn-mind] status:', JSON.stringify(st))
    // #96: a prominent corpus line so the user can confirm the mind is present even
    // when a sync run's adopted-delta is 0.
    if (typeof (st as any).memories === 'number') {
      console.log(`[ckn-mind] mind corpus: ${(st as any).memories} memories`)
    }
    return
  }

  // Sync.
  if (serverUp) {
    // The FIRST adopt of a large mind (clone + re-index thousands of nodes) can
    // run well past 2 minutes server-side; a tight CLI abort orphaned a sync the
    // server actually completed ("operation aborted due to timeout"). Default
    // generous; override with CKN_MIND_SYNC_TIMEOUT_MS (0 = no client timeout).
    const timeoutMs = Number(process.env.CKN_MIND_SYNC_TIMEOUT_MS ?? '1800000')
    const res = await fetch(`${SERVER_URL}/api/mind/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipWorktreeFetch: freshlyCloned }),
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[ckn-mind] server sync failed (${res.status}): ${body.slice(0, 200)}`)
      process.exit(1)
    }
    // Adopted memories are in the graph now → regenerate the local hard
    // engagement block so the human's style is live from the first session.
    try { await syncEngagementBlock() } catch { /* best-effort */ }
    console.log(reportText((await res.json()) as MindSyncReport))
    return
  }

  // Server down — direct. The reconcile is filesystem+git only; re-index the
  // graph directly afterward since no server owns the writer.
  if (process.env.CKN_FORCE_SERVER === '1') {
    console.error('[ckn-mind] server down and CKN_FORCE_SERVER=1 — refusing direct run.')
    process.exit(1)
  }
  const { mindSync, detectDuplicates, changedLocalPaths, readCodegraphSnapshot } =
    await import('../server/privateMind.js')
  const report = await mindSync({ skipWorktreeFetch: freshlyCloned })
  if (report.enabled) {
    const os = await import('node:os')
    const { syncMemories } = await import('../server/graph/sync.js')
    await syncMemories(os.homedir())
    // Server down → no lock contention; replay adopted codegraph snapshots directly.
    const { upsertSymbols, forgetRepoSymbols } = await import('../server/graph/symbols.js')
    report.codegraphReplayed = []
    for (const repo of report.codegraphAdopted) {
      const snap = await readCodegraphSnapshot(repo)
      if (!snap) continue
      const r = await upsertSymbols(snap, { reExtractedRepos: [repo] })
      report.codegraphReplayed.push({ repo, symbols: r.symbols, edges: r.edges, invalidated: r.invalidated })
    }
    // A peer forgot these repos → drop them from our local graph too.
    for (const repo of report.codegraphForgotten ?? []) {
      await forgetRepoSymbols(repo)
    }
    report.duplicates = await detectDuplicates(changedLocalPaths(report))
  }
  // Regenerate the local hard engagement block from the freshly-adopted mind.
  try { await syncEngagementBlock() } catch { /* best-effort */ }
  console.log(reportText(report))
}

main().catch((e) => {
  console.error('[ckn-mind] fatal:', e?.message ?? e)
  process.exit(1)
})
