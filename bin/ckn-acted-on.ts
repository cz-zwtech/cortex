#!/usr/bin/env tsx
/**
 * ckn-acted-on — read-only s3 acted-on inspector. For a memory, shows which
 * sessions it surfaced in, whether each was ACTED-ON (a file the memory mentions
 * was edited in that session), and the corroborating file pairs. A SIGNAL
 * inspector: corroborate-not-authorize — it never writes or gates anything.
 *
 *   ckn-acted-on <memoryId>              # every surfaced session + verdicts
 *   ckn-acted-on <memoryId> <sessionId>  # just that pair (boolean + matches)
 *
 * Reads the graph directly (WAL-safe concurrent read; no writes), so it works
 * whether or not the server is up. See actedOn.ts + the s3 design doc.
 */
import { getDb } from '../server/graph/db.js'
import { actedOn, actedOnReport } from '../server/graph/actedOn.js'

const [memoryId, sessionId] = process.argv.slice(2)
if (!memoryId) {
  console.error('usage: ckn-acted-on <memoryId> [sessionId]')
  process.exit(2)
}
getDb()

if (sessionId) {
  const acted = actedOn(memoryId, sessionId)
  console.log(`${acted ? 'ACTED-ON' : 'not acted-on'}  ${memoryId}  ⋈  ${sessionId}`)
  const matches = actedOnReport(memoryId).find((r) => r.session === sessionId)?.matches ?? []
  for (const m of matches) console.log(`  ${m.mentioned}  ⋈  ${m.edited}`)
  process.exit(0)
}

const rep = actedOnReport(memoryId)
if (rep.length === 0) {
  console.log(`${memoryId}: surfaced in 0 sessions (no SURFACED_IN edges yet)`)
  process.exit(0)
}
const actedCount = rep.filter((r) => r.acted).length
console.log(`${memoryId}: surfaced in ${rep.length} session(s), acted-on in ${actedCount}`)
for (const r of rep) {
  console.log(`  ${r.acted ? '✓' : '·'} ${r.session}${r.acted ? '' : '  (surfaced, not acted-on)'}`)
  for (const m of r.matches) console.log(`      ${m.mentioned}  ⋈  ${m.edited}`)
}
