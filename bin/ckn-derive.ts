#!/usr/bin/env tsx
/**
 * ckn-derive — CLI wrapper for observation derivation.
 *
 * Same single-writer constraint as ckn-sync: the graph DB has one
 * writer at a time. When the Cortex server is running it owns that
 * writer, so this CLI calls the server's POST /api/derive endpoint
 * (which runs the derivation in-process, reusing the server's
 * connection). Only when no server is bound to port 3001 do we fall
 * back to direct-DB by importing the same module the endpoint uses.
 *
 * Flags:
 *   --scope <prefix>       Restrict to memories whose scope starts here.
 *   --min-cluster N        Minimum cluster size (default 3).
 *   --cosine-min 0.7       Cosine threshold for cluster membership.
 *   --dry-run              Print clusters; write nothing.
 *
 * Influences:
 *   - Hindsight (vectorize.io) — Observations + trend tracking.
 *   - Honcho (plastic-labs) — async derivation decoupled from ingest.
 */
import net from 'node:net'

const SERVER_URL = 'http://localhost:3001'
const SERVER_PORT = 3001

interface CLIFlags {
  scope: string | null
  minCluster: number | null
  cosineMin: number | null
  dryRun: boolean
}

const parseFlags = (): CLIFlags => {
  const argv = process.argv.slice(2)
  const flags: CLIFlags = { scope: null, minCluster: null, cosineMin: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--scope') flags.scope = argv[++i] ?? null
    else if (a === '--min-cluster') flags.minCluster = Number(argv[++i] ?? '3')
    else if (a === '--cosine-min') flags.cosineMin = Number(argv[++i] ?? '0.7')
    else if (a === '--dry-run') flags.dryRun = true
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: ckn-derive [--scope <scope>] [--min-cluster N] [--cosine-min 0.7] [--dry-run]',
      )
      process.exit(0)
    }
  }
  return flags
}

const isPortBound = (port: number, host = '127.0.0.1', timeoutMs = 200): Promise<boolean> =>
  new Promise((resolve) => {
    const s = new net.Socket()
    s.setTimeout(timeoutMs)
    const done = (v: boolean) => { s.destroy(); resolve(v) }
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
    s.connect(port, host)
  })

interface DeriveResult {
  candidates: number
  clusters: {
    observationId: string
    observationName: string
    scope: string
    trend: string
    memberIds: string[]
  }[]
  created: number
  dryRun: boolean
}

const deriveViaApi = async (body: Record<string, unknown>): Promise<DeriveResult | null> => {
  try {
    const res = await fetch(`${SERVER_URL}/api/derive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      console.warn(`[ckn derive] server returned ${res.status}${txt ? `: ${txt.slice(0, 300)}` : ''}`)
      return null
    }
    return (await res.json()) as DeriveResult
  } catch (e: any) {
    console.warn(`[ckn derive] api request failed: ${e?.message ?? e}`)
    return null
  }
}

const reportResult = (result: DeriveResult, dryRun: boolean) => {
  console.log(
    `[ckn derive] ${result.candidates} candidates → ${result.clusters.length} clusters` +
      (dryRun ? ' (dry-run)' : ''),
  )
  for (const c of result.clusters) {
    const sample = c.memberIds.slice(0, 5).join(', ')
    const more = c.memberIds.length > 5 ? ` (+${c.memberIds.length - 5} more)` : ''
    console.log(`  - ${c.observationId} [${c.trend}] members: ${sample}${more}`)
  }
  if (!dryRun) console.log(`[ckn derive] created ${result.created} observations.`)
}

const main = async (): Promise<void> => {
  const flags = parseFlags()
  const body: Record<string, unknown> = { dryRun: flags.dryRun }
  if (flags.scope) body.scope = flags.scope
  if (flags.minCluster !== null) body.minCluster = flags.minCluster
  if (flags.cosineMin !== null) body.cosineMin = flags.cosineMin

  // HTTP-first — the server owns the single SQLite writer when it's running.
  const viaApi = await deriveViaApi(body)
  if (viaApi) {
    reportResult(viaApi, flags.dryRun)
    return
  }

  // HTTP failed. Direct-DB fallback is only safe when nothing is bound
  // to the server port; otherwise the server owns the writer and
  // we'd contend.
  if (await isPortBound(SERVER_PORT)) {
    console.error(
      '[ckn derive] server is alive but HTTP request failed — refusing direct-DB fallback (would contend with the server writer).',
    )
    process.exit(1)
  }

  if (process.env.CKN_FORCE_SERVER === '1') {
    console.error('[ckn derive] server unreachable and CKN_FORCE_SERVER=1 — refusing to fall back to direct DB.')
    process.exit(1)
  }

  // No server listening — safe to open a direct connection.
  const { deriveObservations } = await import('../server/graph/derive.js')
  const result = await deriveObservations({
    scope: flags.scope,
    minCluster: flags.minCluster ?? undefined,
    cosineMin: flags.cosineMin ?? undefined,
    dryRun: flags.dryRun,
  })
  reportResult(result, flags.dryRun)
}

main().catch((e) => {
  console.error('[ckn derive] fatal:', e?.message ?? e)
  process.exit(1)
})
