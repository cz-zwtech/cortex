#!/usr/bin/env tsx
/**
 * Path B profile-facet capture — the OAuth/subscription path.
 *
 * Reads facet-candidate JSON (the `{ "facets": [...] }` shape the
 * FACET_SYSTEM_PROMPT emits) from stdin or --file, validates it through the
 * SAME parser Path A uses (bin/_profile-facets.ts → parseFacetResponse, so the
 * accept/reject rules never drift), and POSTs to /api/profile/observe for the
 * current session.
 *
 * The interactive Claude (e.g. the /cortex-snapshot slash command) does the extraction
 * itself, so this needs NO ANTHROPIC_API_KEY — that is the whole point: profile
 * capture works on a plain claude.ai subscription. Path A (ckn-extract at
 * SessionEnd) is the API-billed equivalent; this is its manual, subscription
 * counterpart.
 *
 * Usage:
 *   echo '{"facets":[...]}' | npx tsx bin/ckn-observe-facets.ts [--session <id>]
 *   npx tsx bin/ckn-observe-facets.ts --file facets.json [--session <id>]
 *
 * Session id resolves: --session <id> → $CLAUDE_CODE_SESSION_ID → most-recent
 * transcript for the cwd. Server URL: $CKN_SERVER_URL ?? http://localhost:3001.
 */
import * as fs from 'node:fs'
import { SERVER_URL } from './_graph-guard.js'
import { parseFacetResponse } from './_profile-facets.js'
import { resolveCurrentSession } from './_session-id.js'

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  // --declared seeds user-stated onboarding preferences (no session evidence) → /seed.
  // Facets are tracked regardless of CKN_PROFILE (which gates only surfacing),
  // so observing/seeding always runs — the profile is ready when the user opts in.
  const declared = process.argv.includes('--declared')

  const file = flag('--file')
  const text = (file ? fs.readFileSync(file, 'utf8') : await readStdin()).trim()
  if (!text) {
    console.error('ckn-observe-facets: no facet JSON on stdin (or --file). Expected { "facets": [...] }.')
    process.exit(2)
  }

  // Same validation Path A applies: drops unknown dimensions / malformed rows,
  // preserves classification (the server drops `override` — it is not a perception).
  const candidates = parseFacetResponse(text)
  if (candidates.length === 0) {
    console.log('ckn-observe-facets: 0 valid facet candidates parsed — nothing to observe.')
    return
  }

  // Declared (onboarding) seeds carry no session evidence — POST to /seed, not /observe.
  if (declared) {
    let seedRes: Response
    try {
      seedRes = await fetch(`${SERVER_URL}/api/profile/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidates }),
      })
    } catch (e: any) {
      console.error(`ckn-observe-facets: cannot reach Cortex at ${SERVER_URL} (${e?.message ?? e}) — is the server up?`)
      process.exit(1)
    }
    const seedBody: any = await seedRes.json().catch(() => ({}))
    if (!seedRes.ok) {
      console.error(`ckn-observe-facets: seed failed (${seedRes.status})`, seedBody?.error ?? seedBody)
      process.exit(1)
    }
    const seeded = Number(seedBody?.seeded ?? 0)
    console.log(`ckn-observe-facets: seeded ${seeded} declared facet(s) (${candidates.length} candidate(s) sent).`)
    return
  }

  const sessionId =
    flag('--session') ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    (await resolveCurrentSession(process.cwd()))
  if (!sessionId) {
    console.error('ckn-observe-facets: no session id — pass --session <id> or set CLAUDE_CODE_SESSION_ID')
    process.exit(2)
  }

  let res: Response
  try {
    res = await fetch(`${SERVER_URL}/api/profile/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, candidates }),
    })
  } catch (e: any) {
    console.error(`ckn-observe-facets: cannot reach Cortex at ${SERVER_URL} (${e?.message ?? e}) — is the server up?`)
    process.exit(1)
  }

  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error(`ckn-observe-facets: observe failed (${res.status})`, body?.error ?? body)
    process.exit(1)
  }
  const ingested = Number(body?.ingested ?? 0)
  console.log(
    `ckn-observe-facets: observed ${ingested} facet(s) for session ${sessionId.slice(0, 8)} ` +
    `(${candidates.length} candidate(s) sent${candidates.length - ingested > 0 ? `, ${candidates.length - ingested} dropped` : ''}).`,
  )
}

main().catch((e) => {
  console.error('ckn-observe-facets:', e?.message ?? e)
  process.exit(1)
})
