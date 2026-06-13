#!/usr/bin/env tsx
/**
 * ckn-sync-shared — pull the shared mind, import memories into the graph,
 * compute divergence memories against local artifacts.
 *
 * Conversation-callable. The `/cortex-sync-shared` slash command tells Claude to
 * run this; the user can also run it manually. Output is human-readable
 * so Claude can summarize it back.
 *
 * Strategy mirrors ckn-sync.ts:
 *   1. Try the API server (fast, single owner of the graph writer).
 *   2. Fall back to direct module access — works without the UI running.
 */
import os from 'node:os'

const SERVER_URL = 'http://localhost:3001'

interface CliArgs {
  /** Optional remote URL to configure before syncing. Used for headless
   *  bootstrap of a fresh worker box — no UI needed. */
  remote: string | null
}

const parseArgs = (): CliArgs => {
  const argv = process.argv.slice(2)
  const out: CliArgs = { remote: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--remote') out.remote = argv[++i] ?? null
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage:\n' +
          '  ckn-sync-shared                          pull from configured remote\n' +
          '  ckn-sync-shared --remote <git-url>       configure remote first, then pull',
      )
      process.exit(0)
    }
  }
  return out
}

/**
 * Set the cortex-mind remote URL before syncing. Tries the API first
 * (POST /api/shared/remote), falls back to direct module call.
 * Idempotent — safe to re-run with the same URL.
 */
async function setRemote(url: string): Promise<void> {
  // API path
  try {
    const res = await fetch(`${SERVER_URL}/api/shared/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) return
  } catch {
    // fall through
  }
  // Direct path
  const { setRemote: setRemoteDirect, DEFAULT_SHARED_PATH } = await import('../server/sharedMind.js')
  await setRemoteDirect(DEFAULT_SHARED_PATH, url)
}

interface SyncReport {
  pulled: boolean
  pullError: string | null
  imported: number
  skipped: number
  divergences?: number
  scope: string
}

async function syncViaApi(): Promise<SyncReport | null> {
  try {
    const res = await fetch(`${SERVER_URL}/api/shared/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return null
    return (await res.json()) as SyncReport
  } catch {
    return null
  }
}

async function syncDirect(): Promise<SyncReport> {
  // Lazy import — keeps this script's startup cost low when the API path wins.
  const { sync, getManifest, DEFAULT_SHARED_PATH } = await import('../server/sharedMind.js')
  const { run, transaction } = await import('../server/graph/db.js')
  const path = await import('node:path')

  const localPath = DEFAULT_SHARED_PATH
  const result = await sync(localPath)
  const manifest = await getManifest(localPath)
  const scope = `shared:${manifest.name}`

  const now = Date.now()
  let imported = 0
  let skipped = 0
  for (const m of result.memories) {
    try {
      const fmMatch = m.body.match(/^---\n([\s\S]*?)\n---\n?/)
      let body = m.body
      let name = m.name
      let description = ''
      let kind = 'memory'
      if (fmMatch) {
        const fm = fmMatch[1] ?? ''
        body = m.body.slice(fmMatch[0].length)
        const nameMatch = fm.match(/^name:\s*(.+)$/m)
        const descMatch = fm.match(/^description:\s*(.+)$/m)
        const typeMatch = fm.match(/^type:\s*(.+)$/m)
        if (nameMatch) name = nameMatch[1]!.trim()
        if (descMatch) description = descMatch[1]!.trim()
        if (typeMatch) kind = typeMatch[1]!.trim()
      }
      const id = `${scope}/${path.basename(m.sourcePath, '.md')}`
      // Drop the node and its edges, then re-insert — atomic per memory.
      transaction(() => {
        run('DELETE FROM edges WHERE src = ? OR dst = ?', id, id)
        run('DELETE FROM entries WHERE id = ?', id)
        run(
          `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          name,
          kind,
          description,
          body.slice(0, 8192),
          m.sourcePath,
          scope,
          now,
          now,
        )
      })
      imported++
    } catch {
      skipped++
    }
  }
  return {
    pulled: result.pulled,
    pullError: result.pullError,
    imported,
    skipped,
    scope,
  }
}

async function main() {
  const args = parseArgs()
  if (args.remote) {
    console.log(`[ckn-shared] configuring remote: ${args.remote}`)
    try {
      await setRemote(args.remote)
    } catch (e: any) {
      console.error(`[ckn-shared] remote config failed: ${e?.message ?? e}`)
      process.exit(1)
    }
  }
  let report = await syncViaApi()
  let path = 'api'
  if (!report) {
    // API failed. syncDirect opens the graph DB directly — only safe when no
    // server owns the writer. If the server is up, fail loud instead of
    // contending.
    const { directFallbackMode } = await import('./_graph-guard.js')
    if ((await directFallbackMode()) === 'fail-loud') {
      console.error(
        '[ckn-shared] server is up but /api/shared/sync failed — not falling back to direct DB (would contend with the server writer). Retry, or check the server.',
      )
      process.exit(1)
    }
    path = 'direct'
    report = await syncDirect()
  }
  // Format for Claude to read back. Plain text, structured.
  console.log(`[ckn-shared] sync via ${path}`)
  console.log(`  scope:        ${report.scope}`)
  console.log(`  pulled:       ${report.pulled ? 'yes' : 'no'}`)
  if (report.pullError) console.log(`  pull error:   ${report.pullError}`)
  console.log(`  memories in:  ${report.imported}`)
  if (report.skipped > 0) console.log(`  skipped:      ${report.skipped}`)
  if (typeof report.divergences === 'number') {
    console.log(`  divergences:  ${report.divergences}`)
  }
}

void main().catch((e) => {
  console.error('[ckn-shared] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

// Silence unused — os may be referenced in future versions for path resolution.
void os
