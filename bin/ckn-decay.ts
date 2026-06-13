#!/usr/bin/env tsx
/**
 * ckn-decay — the s4 decay REVIEW SURFACE. Shows which memories are fading
 * (decay candidates), WHY the rest are exempt, and lets the human reinforce
 * ('keep') or archive (a reversible, default-OFF scaffold). MARK never delete:
 * decay only ranks relevance — nothing is removed without the human, and even
 * archive is reversible + opt-in. See server/graph/decay.ts + the s4 proposal.
 *
 *   ckn-decay [N]            # list the top-N decay candidates (default 20) + exempt tally
 *   ckn-decay show <id>      # full decay badges for one memory (reason/reinforcement/directive)
 *   ckn-decay keep <id>      # reinforce: a curation touch that resets coldness
 *   ckn-decay archive <id>   # reversible archive — default-OFF scaffold (CKN_DECAY_ARCHIVE=1)
 *
 * Reads the graph directly (WAL-safe; the scoring is read-only). `keep` records a
 * curation surfacing (s1). Time boundary is here: callers pass asOf=now inward.
 */
import { getDb } from '../server/graph/db.js'
import { decayScore, decayReview, keepMemory } from '../server/graph/decay.js'

const DAY = 86_400_000
const [cmd, arg] = process.argv.slice(2)
getDb()
const now = Date.now()

if (cmd === 'keep') {
  if (!arg) { console.error('usage: ckn-decay keep <memoryId>'); process.exit(2) }
  keepMemory(arg, now)
  console.log(`kept (reinforced) ${arg} — coldness reset, surfacing count bumped; it drops out of the decay list.`)
  process.exit(0)
}

if (cmd === 'show') {
  if (!arg) { console.error('usage: ckn-decay show <memoryId>'); process.exit(2) }
  const r = decayScore(arg, now)
  console.log(`${arg}`)
  console.log(`  score        ${r.score.toFixed(3)}${r.stale ? '  (STALE)' : ''}`)
  console.log(`  exempt       ${r.exempt ? `yes — ${r.reason}` : 'no'}`)
  console.log(`  reinforcement ${r.reinforcement ?? 'none'}`)   // Q5 badge: D3 causal > D1 co-occurrence
  console.log(`  directive    ${r.isDirective ? 'yes (decays slower)' : 'no'}`) // Q6
  console.log(`  surfacings   ${r.surfacings}`)
  console.log(`  coldness     ${(r.coldnessMs / DAY).toFixed(0)}d since last surfaced`)
  process.exit(0)
}

if (cmd === 'archive') {
  if (!arg) { console.error('usage: ckn-decay archive <memoryId>'); process.exit(2) }
  if (process.env.CKN_DECAY_ARCHIVE !== '1') {
    console.log(`archive is a default-OFF scaffold — decay MARKS + ranks down, it never removes.`)
    console.log(`Enable reversible archive with CKN_DECAY_ARCHIVE=1 (opt-in, recoverable). Nothing archived.`)
    process.exit(0)
  }
  // Reversible archive scaffold (enabled): the real move (relocate the .md out of
  // the synced memory dir, restorable) is the archive fast-follow; v0 ships the
  // gated entry point so the default-off contract + opt-in path exist now.
  console.log(`[scaffold] reversible-archive enabled but the move is a fast-follow — ${arg} left in place (still MARK, not deleted).`)
  process.exit(0)
}

// default: list the decay candidates
const limit = Number(cmd) > 0 ? Number(cmd) : 20
const r = decayReview(now, { limit })
console.log(`decay review — ${r.scanned} memories scored, top ${r.candidates.length} candidate(s) (MARK, never delete):\n`)
for (const c of r.candidates) {
  const badge = c.isDirective ? 'directive' : ''
  const flag = c.stale ? 'STALE' : ''
  console.log(
    `  ${c.score.toFixed(3)}  ${`${flag} ${badge}`.trim().padEnd(16)} surf=${c.surfacings}  cold=${(c.coldnessMs / DAY).toFixed(0)}d  ${c.memoryId}`,
  )
}
const tally = Object.entries(r.exemptByReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ')
if (tally) console.log(`\nexempt (${Object.values(r.exemptByReason).reduce((a, b) => a + b, 0)}): ${tally}`)
console.log(`\nreinforce: ckn-decay keep <id>   ·   inspect: ckn-decay show <id>   ·   archive (off): ckn-decay archive <id>`)
