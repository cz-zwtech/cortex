/**
 * Profile facets — the AI's evidence-grounded PERCEPTION of the human.
 * Mirrors the observation node pattern (server/graph/derive.ts) but corroborates
 * by exact (dimension, facet_key, stance) rather than embedding clustering, so it
 * is deterministic and needs no embeddings. NOT human-editable: perception moves
 * only via behavioral counter-evidence (trend decay) or an earned competing facet.
 */
import { all, get, run, transaction } from './db.js'

export const PROFILE_DIMENSIONS = [
  'communication', 'cognition', 'work-cadence', 'autonomy',
  'technical-depth', 'values', 'affinities', 'disposition',
] as const
export type ProfileDimension = (typeof PROFILE_DIMENSIONS)[number]
export const INJECT_MIN = 0.6
const CORROBORATION_BASE = 0.6
const STALE_AGE_DAYS = 60
const STRENGTHEN_DAYS = 7

// Declared (user-seeded) facets: a warm start for a blank profile. They don't earn
// confidence from sessions — they start at SEED_CONFIDENCE (just above INJECT_MIN) and
// decay by age from when they were seeded, so behavioral evidence overtakes a stated
// preference and an un-corroborated seed fades below the injection bar on its own.
export const SEED_CONFIDENCE = 0.62
const SEED_FRESH_DAYS = 14   // full seed strength for two weeks (grace period for behavior to corroborate)
const SEED_STALE_DAYS = 60   // fully decayed to the floor by here
const SEED_FLOOR = 0.3

export interface FacetCandidate {
  dimension: ProfileDimension
  facet_key: string
  stance: string
  statement: string
  valence: 'like' | 'dislike' | 'trait' | 'neutral'
}
export interface Facet {
  id: string
  dimension: string
  facet_key: string
  stance: string
  statement: string
  valence: string
  competing_group: string
  confidence: number
  trend: 'stable' | 'strengthening' | 'weakening' | 'stale'
  evidence_count: number
  first_observed: number
  last_observed: number
  source: 'observed' | 'declared'
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x'

export const facetId = (c: Pick<FacetCandidate, 'dimension' | 'facet_key' | 'stance'>): string =>
  `profile_facet:user/${c.dimension}/${slug(c.facet_key)}/${slug(c.stance)}`
export const competingGroup = (c: Pick<FacetCandidate, 'dimension' | 'facet_key'>): string =>
  `${c.dimension}:${slug(c.facet_key)}`

const staleFactor = (trend: Facet['trend']): number =>
  trend === 'stale' ? 0.5 : trend === 'weakening' ? 0.8 : 1
export const computeConfidence = (distinctSessions: number, trend: Facet['trend']): number =>
  +((1 - Math.pow(CORROBORATION_BASE, distinctSessions)) * staleFactor(trend)).toFixed(4)

const WEAKEN_AGE_DAYS = 30
/** Trend is RECENCY-of-corroboration, computed live from last_observed age. This is how
 * decay happens with no cron: a facet not re-observed slides strengthening→stable→weakening→stale,
 * and computeConfidence's staleFactor decays its confidence — so a perception the human stopped
 * corroborating (by behaving differently) fades below the injection bar on its own (spec §1.1). */
const liveTrend = (last: number, now: number): Facet['trend'] => {
  const ageDays = (now - last) / 86_400_000
  if (ageDays > STALE_AGE_DAYS) return 'stale'
  if (ageDays < STRENGTHEN_DAYS) return 'strengthening'
  if (ageDays > WEAKEN_AGE_DAYS) return 'weakening'
  return 'stable'
}
/** Declared-seed confidence: starts at SEED_CONFIDENCE and decays purely by age from the
 * seed time (first_observed), faster than the observed corroboration clock. No cron — like
 * liveTrend, it's a function of age computed at read time. */
const declaredConfidence = (seededAt: number, now: number): number => {
  const ageDays = (now - seededAt) / 86_400_000
  if (ageDays <= SEED_FRESH_DAYS) return SEED_CONFIDENCE
  if (ageDays >= SEED_STALE_DAYS) return SEED_FLOOR
  const t = (ageDays - SEED_FRESH_DAYS) / (SEED_STALE_DAYS - SEED_FRESH_DAYS)
  return +(SEED_CONFIDENCE - t * (SEED_CONFIDENCE - SEED_FLOOR)).toFixed(4)
}

/** Recompute trend + confidence from age at READ time (stored columns are a last-write snapshot).
 * A `declared` seed contributes a decaying floor; once behavioral evidence (the observed
 * corroboration confidence) exceeds it, the observed value wins — so a corroborated seed
 * strengthens, while an abandoned one fades below INJECT_MIN on its own. */
const liveFacet = (f: Facet, now = Date.now()): Facet => {
  const trend = liveTrend(f.last_observed, now)
  const observed = computeConfidence(f.evidence_count, trend)
  if (f.source === 'declared') {
    return { ...f, trend, confidence: Math.max(declaredConfidence(f.first_observed, now), observed) }
  }
  return { ...f, trend, confidence: observed }
}

/** Ensure a `session:<id>` stub entry exists so DERIVED_FROM has a real dst. */
const ensureSessionNode = (sessionId: string, now: number): string => {
  const id = `session:${sessionId}`
  run(
    `INSERT OR IGNORE INTO entries (id, name, kind, scope, updatedAt, syncedAt)
     VALUES (?, ?, 'session', ?, ?, ?)`,
    id, sessionId, `session:${sessionId}`, now, now,
  )
  return id
}

/** Merge one candidate into its facet, recording the source session as evidence. */
export function observeFacet(c: FacetCandidate, sessionId: string, now: number): void {
  const id = facetId(c)
  const group = competingGroup(c)
  transaction(() => {
    const sessNode = ensureSessionNode(sessionId, now)
    // Idempotent evidence edge: facet → session (composite PK gives dedupe).
    run(`INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, 'DERIVED_FROM')`, id, sessNode)
    const distinct = Number(
      get<{ c: number }>(
        `SELECT COUNT(DISTINCT dst) AS c FROM edges WHERE src = ? AND rel = 'DERIVED_FROM'`, id,
      )?.c ?? 0,
    )
    const prior = get<{ first_observed: number; evidence_count: number }>(
      `SELECT first_observed, evidence_count FROM profile_facet_meta WHERE id = ?`, id,
    )
    const first = prior?.first_observed && prior.first_observed > 0 ? prior.first_observed : now
    // DERIVED_FROM edges only ever grow, so local `distinct` only grows; a stored count ABOVE
    // distinct can only come from a federation merge (importProfileSnapshot's max()). Preserve
    // that cross-machine corroboration (spec §9) — never let a local observe erode it.
    const evidence = Math.max(distinct, prior?.evidence_count ?? 0)
    // Snapshot at observe time = just corroborated → strengthening. Reads recompute via liveFacet.
    const trend = liveTrend(now, now)
    const confidence = computeConfidence(evidence, trend)
    run(
      `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt)
       VALUES (?, ?, 'profile_facet', ?, '', 'profile', 'user', ?, ?)
       ON CONFLICT(id) DO UPDATE SET description = excluded.description, updatedAt = excluded.updatedAt`,
      id, `${c.dimension}: ${c.stance}`, c.statement, now, now,
    )
    // source='observed' on a brand-new facet. On conflict we do NOT touch source, so a
    // user-`declared` seed that behavior now corroborates keeps its provenance label while
    // accruing evidence — liveFacet's max() lets the observed confidence overtake the seed.
    run(
      `INSERT INTO profile_facet_meta
         (id, dimension, facet_key, stance, valence, competing_group, confidence, trend,
          evidence_count, first_observed, last_observed, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed')
       ON CONFLICT(id) DO UPDATE SET valence = excluded.valence, confidence = excluded.confidence,
         trend = excluded.trend, evidence_count = excluded.evidence_count,
         last_observed = excluded.last_observed`,
      id, c.dimension, slug(c.facet_key), slug(c.stance), c.valence, group,
      confidence, trend, evidence, first, now,
    )
  })
}

/**
 * Seed a user-DECLARED facet from onboarding ("how would you like me to interact?").
 * Distinct from observeFacet: no session evidence, source='declared', a fixed starting
 * confidence (SEED_CONFIDENCE) that decays faster than the observed clock. Never downgrades
 * a facet behavior has already observed — real evidence outranks a stated preference. Re-seeding
 * a declared facet refreshes its statement + resets the decay clock (the user re-affirmed it).
 */
export function seedFacet(c: FacetCandidate, now: number): void {
  const id = facetId(c)
  const group = competingGroup(c)
  transaction(() => {
    const prior = get<{ source: string }>(
      `SELECT source FROM profile_facet_meta WHERE id = ?`, id,
    )
    if (prior?.source === 'observed') return  // behavior already speaks; don't overwrite it
    run(
      `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt)
       VALUES (?, ?, 'profile_facet', ?, '', 'profile', 'user', ?, ?)
       ON CONFLICT(id) DO UPDATE SET description = excluded.description, updatedAt = excluded.updatedAt`,
      id, `${c.dimension}: ${c.stance}`, c.statement, now, now,
    )
    run(
      `INSERT INTO profile_facet_meta
         (id, dimension, facet_key, stance, valence, competing_group, confidence, trend,
          evidence_count, first_observed, last_observed, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'strengthening', 0, ?, ?, 'declared')
       ON CONFLICT(id) DO UPDATE SET valence = excluded.valence,
         competing_group = excluded.competing_group, confidence = excluded.confidence,
         trend = 'strengthening', first_observed = excluded.first_observed,
         last_observed = excluded.last_observed`,
      id, c.dimension, slug(c.facet_key), slug(c.stance), c.valence, group,
      SEED_CONFIDENCE, now, now,
    )
  })
}

export function getFacet(id: string): Facet | null {
  const row = get<any>(
    `SELECT e.id AS id, e.description AS statement,
            m.dimension, m.facet_key, m.stance, m.valence, m.competing_group,
            m.confidence, m.trend, m.evidence_count, m.first_observed, m.last_observed, m.source
       FROM entries e JOIN profile_facet_meta m ON e.id = m.id
      WHERE e.id = ?`, id,
  )
  return row ? liveFacet(row as Facet) : null
}

export interface ActiveFacetsOpts { minConfidence?: number }

/** One active facet per competing_group: highest confidence, tie → most recent. */
export function activeFacets(opts: ActiveFacetsOpts = {}): Facet[] {
  const min = opts.minConfidence ?? 0
  const rows = all<Facet>(
    `SELECT e.id AS id, e.description AS statement,
            m.dimension, m.facet_key, m.stance, m.valence, m.competing_group,
            m.confidence, m.trend, m.evidence_count, m.first_observed, m.last_observed, m.source
       FROM entries e JOIN profile_facet_meta m ON e.id = m.id
      WHERE e.kind = 'profile_facet'`,
  )
  const now = Date.now()
  const best = new Map<string, Facet>()
  for (const raw of rows) {
    const f = liveFacet(raw, now)  // recompute trend+confidence from age → decay applies here
    const cur = best.get(f.competing_group)
    if (!cur || f.confidence > cur.confidence ||
        (f.confidence === cur.confidence && f.last_observed > cur.last_observed)) {
      best.set(f.competing_group, f)
    }
  }
  return [...best.values()]
    .filter((f) => f.confidence >= min)
    .sort((a, b) => b.confidence - a.confidence)
}

export interface ProfileView { narrative: string; facets: Facet[] }

export function getProfile(opts: ActiveFacetsOpts = {}): ProfileView {
  const narrative = get<{ content: string }>(
    `SELECT content FROM entries WHERE id = 'profile_narrative:user'`,
  )?.content ?? ''
  const facets = activeFacets(opts)
  // Confidence-gate rail (spec §10): a narrative is only as live as the facets it summarizes.
  // If every supporting facet has decayed below the requested gate, suppress the stale narrative.
  return { narrative: facets.length ? narrative : '', facets }
}

/** Total facets on record (declared + observed, any confidence). 0 ⇒ a blank profile —
 * the onboarding trigger. Counts rows, NOT the injection-gated view, so a user whose facets
 * merely decayed below the bar (already onboarded) is not treated as never-onboarded, and a
 * profile adopted from another machine via private-mind suppresses the prompt. */
export function profileFacetCount(): number {
  return Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM profile_facet_meta`)?.c ?? 0)
}

/** Tier support: wipe all profile nodes (used by private-mind forget) — both the
 * profile_facet nodes and the synthesized profile_narrative:user node, so a forget
 * leaves no stale "about the human" description behind for getProfile to inject. The
 * returned count includes the narrative node when present. */
export function forgetProfile(): number {
  const facets = Number(get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM entries WHERE kind = 'profile_facet'`)?.c ?? 0)
  const narrative = Number(get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM entries WHERE id = 'profile_narrative:user'`)?.c ?? 0)
  transaction(() => {
    run(`DELETE FROM edges WHERE src IN (SELECT id FROM entries WHERE kind='profile_facet')`)
    run(`DELETE FROM profile_facet_meta`)
    run(`DELETE FROM entries WHERE kind = 'profile_facet'`)
    run(`DELETE FROM edges WHERE src = 'profile_narrative:user' OR dst = 'profile_narrative:user'`)
    run(`DELETE FROM entries WHERE id = 'profile_narrative:user'`)
  })
  return facets + narrative
}

export interface ProfileSnapshot { narrative: string; facets: Facet[] }

export function exportProfileSnapshot(): ProfileSnapshot {
  const facets = all<Facet>(
    `SELECT e.id AS id, e.description AS statement, m.dimension, m.facet_key, m.stance, m.valence,
            m.competing_group, m.confidence, m.trend, m.evidence_count, m.first_observed, m.last_observed, m.source
       FROM entries e JOIN profile_facet_meta m ON e.id = m.id WHERE e.kind = 'profile_facet'`,
  )
  const narrative = get<{ content: string }>(
    `SELECT content FROM entries WHERE id = 'profile_narrative:user'`)?.content ?? ''
  return { narrative, facets }
}

/** Merge a peer snapshot: per id, take the max evidence_count, earliest first_observed,
 * latest last_observed; recompute confidence from the merged count + trend. Newest narrative wins. */
export function importProfileSnapshot(snap: ProfileSnapshot): void {
  transaction(() => {
    for (const f of snap.facets ?? []) {
      const mine = getFacet(f.id)
      const evidence = Math.max(mine?.evidence_count ?? 0, f.evidence_count ?? 0)
      const first = Math.min(mine?.first_observed || f.first_observed || Date.now(), f.first_observed || Date.now())
      const last = Math.max(mine?.last_observed ?? 0, f.last_observed ?? 0)
      const trend = (f.trend ?? mine?.trend ?? 'stable') as Facet['trend']
      const confidence = computeConfidence(evidence, trend)
      // Merged corroboration means observed somewhere; only a seed with zero evidence on
      // both sides stays 'declared'. (Legacy snapshots predate the column → observed.)
      const source = evidence > 0 ? 'observed' : (f.source ?? mine?.source ?? 'declared')
      run(
        `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt)
         VALUES (?, ?, 'profile_facet', ?, '', 'profile', 'user', ?, ?)
         ON CONFLICT(id) DO UPDATE SET description = excluded.description, updatedAt = excluded.updatedAt`,
        f.id, `${f.dimension}: ${f.stance}`, f.statement, last || Date.now(), last || Date.now(),
      )
      run(
        `INSERT INTO profile_facet_meta (id, dimension, facet_key, stance, valence, competing_group,
            confidence, trend, evidence_count, first_observed, last_observed, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET confidence = excluded.confidence, trend = excluded.trend,
            evidence_count = excluded.evidence_count, first_observed = excluded.first_observed,
            last_observed = excluded.last_observed, source = excluded.source`,
        f.id, f.dimension, f.facet_key, f.stance, f.valence, f.competing_group,
        confidence, trend, evidence, first, last, source,
      )
    }
    if ((snap.narrative ?? '').trim()) {
      const now = Date.now()
      run(
        `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt)
         VALUES ('profile_narrative:user', 'Human profile narrative', 'profile_narrative', '', ?, 'profile', 'user', ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, updatedAt = excluded.updatedAt`,
        snap.narrative, now, now,
      )
    }
  })
}
