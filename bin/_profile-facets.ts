/**
 * Pure helpers for profile-facet extraction (the AI's perception of the human).
 * No I/O — the SessionEnd hook (ckn-extract.ts) handles the API call, network,
 * and state; these just describe + parse so they're unit-testable without
 * firing the hook as an import side effect.
 *
 * The canonical dimension list is owned by server/graph/profile.ts; importing
 * it here keeps the parser's accept/reject in lock-step with the route's
 * validation (no second source of truth to drift).
 */
import { PROFILE_DIMENSIONS } from '../server/graph/profile.js'

export interface ProfileFacetCandidate {
  dimension: string
  facet_key: string
  stance: string
  statement: string
  valence: 'like' | 'dislike' | 'trait' | 'neutral'
  classification: 'perception' | 'challenge' | 'override'
}

export const FACET_SYSTEM_PROMPT = `You build a PERCEPTION profile of the human from a Claude Code session — how they work, think, and prefer to be engaged. This is the AI's read of the person, not a rulebook.

For each distinct signal, output a facet candidate:
- dimension: one of ${PROFILE_DIMENSIONS.join(', ')}
- facet_key: a SHORT canonical slug for the claim, reused across sessions (e.g. "verbosity", "risk-tolerance", "check-in-cadence"). Pick the obvious canonical key; do not invent synonyms.
- stance: the specific position within that key (e.g. "terse", "high", "autonomous"). A contradictory stance on the same facet_key competes with prior ones.
- statement: one descriptive sentence ("Prefers terse answers with options and pros/cons").
- valence: like | dislike | trait | neutral
- classification:
    perception — evidence of how they actually are/behave
    challenge  — they explicitly disputed a perception ("I'm not actually X") → seeds a competing stance
    override   — they asked to be engaged differently for now ("keep it lightweight") WITHOUT claiming it's their nature → NOT a perception

RULES: Only durable signal — skip one-off task mechanics. Prefer few high-quality facets. If the session reveals nothing about the person, return an empty list.
Output JSON only: { "facets": [ ... ] }`

/** Pure parser — extract + validate facet candidates from an LLM text response. */
export function parseFacetResponse(text: string): ProfileFacetCandidate[] {
  let t = text.trim()
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = t.indexOf('{'); const end = t.lastIndexOf('}')
  if (start < 0 || end < 0) return []
  let parsed: any
  try { parsed = JSON.parse(t.slice(start, end + 1)) } catch { return [] }
  const out: ProfileFacetCandidate[] = []
  for (const f of parsed?.facets ?? []) {
    if (!(PROFILE_DIMENSIONS as readonly string[]).includes(f?.dimension)) continue
    if (!f?.facet_key || !f?.stance || !f?.statement) continue
    const valence = ['like','dislike','trait','neutral'].includes(f.valence) ? f.valence : 'neutral'
    const classification = ['perception','challenge','override'].includes(f.classification) ? f.classification : 'perception'
    out.push({ dimension: f.dimension, facet_key: String(f.facet_key), stance: String(f.stance),
      statement: String(f.statement), valence, classification })
  }
  return out
}
