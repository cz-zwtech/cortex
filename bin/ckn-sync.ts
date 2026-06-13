#!/usr/bin/env tsx
/**
 * ckn-sync — standalone CLI for syncing Claude memory files into the graph.
 *
 * Called by the Claude Code Stop hook on every session end.
 * Also callable manually: npx tsx bin/ckn-sync.ts
 *
 * Strategy:
 *   1. Try the running CKN server (HTTP) first.
 *   2. If HTTP fails, probe TCP port 3001:
 *      - bound  → server is alive and owns the single SQLite writer; direct-DB
 *                 fallback would contend. Fail loud.
 *      - unbound → no server; safe to fall back to direct DB.
 *   3. CKN_FORCE_SERVER=1 still forces fail-loud even when no server detected.
 */
import { SERVER_URL, SERVER_PORT, isServerUp } from './_graph-guard.js'
import { memoryHome } from '../server/graph/sync.js'

// Detects a running CKN server even when its HTTP endpoint transiently
// errors. The single-writer DB lock is held by the live server; a direct-DB
// writer in this process would contend. Delegated to the shared guard so the
// port/URL overrides (CKN_PORT / CKN_SERVER_URL) match every other CLI script.
const isPortBound = isServerUp

async function syncViaApi(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/api/graph/sync`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[ckn sync] server returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
      return false
    }
    const data = (await res.json()) as { synced: number; skipped: number; errors: string[] }
    console.log(`[ckn sync] ${data.synced} entries synced, ${data.skipped} skipped`)
    if (data.errors.length) console.warn('[ckn sync] errors:', data.errors)
    return true
  } catch (e: any) {
    // CLI honesty (commit-1 e): name WHY the API call failed instead of falling
    // back silently. The 60s AbortError here was the "false failure" reported
    // while the server-side pass actually completed — surfacing it makes the
    // sync-saturation symptom diagnosable rather than a mystery non-result.
    console.warn(
      `[ckn sync] API sync failed (${e?.name ?? 'Error'}: ${e?.message ?? String(e)}) — falling back to direct`,
    )
    return false
  }
}

async function syncDirect(): Promise<void> {
  // Dynamic import so this only loads when needed (avoids graph-DB init cost when API succeeds)
  const { syncMemories } = await import('../server/graph/sync.js')
  const result = await syncMemories(memoryHome())
  console.log(`[ckn sync] ${result.synced} entries synced, ${result.skipped} skipped`)
  if (result.errors.length) console.warn('[ckn sync] errors:', result.errors)
}

/**
 * Fire-and-forget derive trigger. Called after a successful HTTP sync
 * so observations stay fresh without needing manual `ckn-derive` runs.
 * Detached + unrefed so the Stop hook returns immediately. Off by
 * default — opt in by setting CKN_DERIVE_ON_STOP=1 in env.
 *
 * Skip when no server: derive would have to acquire the graph writer
 * directly. Stop hook fires once per session-end; that's frequent
 * enough that running derive every time during dev would be noisy.
 */
const triggerDeriveDetached = (): void => {
  if (process.env.CKN_DERIVE_ON_STOP !== '1') return
  // The cooldown logic lives server-side via the migration cursor;
  // here we just fire the API endpoint. POST returns quickly when
  // there's nothing new to cluster.
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 5_000)
  fetch(`${SERVER_URL}/api/derive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: ctrl.signal,
  })
    .then(() => clearTimeout(t))
    .catch(() => clearTimeout(t))
}

async function main() {
  if (await syncViaApi()) {
    triggerDeriveDetached()
    return
  }

  // HTTP failed. Direct-DB fallback is only safe when nothing is bound
  // to the server port — otherwise the server owns the writer and
  // we'd contend against it.
  if (await isPortBound(SERVER_PORT)) {
    console.error(
      '[ckn sync] server is alive but HTTP request failed — refusing direct-DB fallback (would contend with the server writer).\n' +
        '  Memory files are safe on disk; next successful sync will fold them in.',
    )
    process.exit(1)
  }

  // Explicit opt-in to fail loud even when no server is detected. Used
  // by worker-mode systemd deployments where direct fallback is never wanted.
  if (process.env.CKN_FORCE_SERVER === '1') {
    console.error(
      '[ckn sync] server unreachable and CKN_FORCE_SERVER=1 — refusing to fall back to direct DB.\n' +
        '  Start the server: ckn-start  (or unset CKN_FORCE_SERVER for solo-host fallback)',
    )
    process.exit(1)
  }

  await syncDirect()
}

main().catch((e) => {
  console.error('[ckn sync] fatal:', e.message)
  process.exit(1)
})
