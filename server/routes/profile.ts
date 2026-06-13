import { Router } from 'express'
import {
  getProfile,
  observeFacet,
  seedFacet,
  exportProfileSnapshot,
  type FacetCandidate,
  PROFILE_DIMENSIONS,
} from '../graph/profile.js'
import { all, run } from '../graph/db.js'
import { mindStatus, persistProfileSnapshot } from '../privateMind.js'
import { profileEnabled } from '../profileEnabled.js'

export const profileRouter = Router()

const isDimension = (d: unknown): d is FacetCandidate['dimension'] =>
  typeof d === 'string' && (PROFILE_DIMENSIONS as readonly string[]).includes(d)

// GET /api/profile?min=0.6 — narrative + active facets (default: injection-gated).
profileRouter.get('/', (req, res) => {
  try {
    const min = req.query.min !== undefined ? Number(req.query.min) : 0
    res.json(getProfile({ minConfidence: Number.isFinite(min) ? min : 0 }))
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }) }
})

// GET /api/profile/enabled — the surfacing switch (env CKN_PROFILE). The UI
// hides the Profile nav item + view when false; facets are still TRACKED
// regardless, so the profile is ready the moment the user opts in.
profileRouter.get('/enabled', (_req, res) => {
  res.json({ enabled: profileEnabled() })
})

// GET /api/profile/engagement — authored interaction directives promoted to the
// hard managed CLAUDE.md block (user-scope feedback with engagement=1), sorted.
profileRouter.get('/engagement', (_req, res) => {
  try {
    const rows = all<{ name: string; description: string; content: string }>(
      `SELECT name, description, content FROM entries
        WHERE kind = 'feedback' AND scope = 'user' AND engagement = 1
        ORDER BY name`,
    )
    const directives = rows.map((r) => ({
      name: r.name,
      // crisp directive = description; fall back to the first non-empty body line.
      text: (r.description || '').trim() || (r.content || '').split('\n').map((l) => l.trim()).find(Boolean) || r.name,
    }))
    res.json({ directives })
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }) }
})

// POST /api/profile/observe { sessionId, candidates:[{dimension,facet_key,stance,statement,valence,classification}] }
// Only 'perception' and 'challenge' candidates become facets; 'override' is ignored here.
profileRouter.post('/observe', async (req, res) => {
  try {
    const { sessionId, candidates } = (req.body ?? {}) as { sessionId?: string; candidates?: any[] }
    if (!sessionId || !Array.isArray(candidates)) {
      return res.status(400).json({ error: 'sessionId and candidates[] required' })
    }
    const now = Date.now()
    let ingested = 0
    for (const c of candidates) {
      if (c?.classification === 'override') continue
      if (!isDimension(c?.dimension) || !c?.facet_key || !c?.stance || !c?.statement) continue
      const valence = ['like', 'dislike', 'trait', 'neutral'].includes(c.valence) ? c.valence : 'neutral'
      observeFacet({ dimension: c.dimension, facet_key: String(c.facet_key), stance: String(c.stance),
        statement: String(c.statement), valence }, String(sessionId), now)
      ingested++
    }
    // When private-mind is enabled, persist the merged profile as the canonical,
    // regenerable profile/profile.json artifact so the next mind-sync federates
    // the human-profile perception across the user's machines. Best-effort,
    // fs-only — never fails the ingest (mirrors graph.ts symbols/upsert persist).
    if (ingested > 0) {
      try {
        if ((await mindStatus()).enabled) await persistProfileSnapshot(exportProfileSnapshot())
      } catch { /* persist is best-effort; the graph ingest already succeeded */ }
    }
    res.json({ ingested })
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }) }
})

// POST /api/profile/seed { candidates:[{dimension,facet_key,stance,statement,valence}] }
// User-DECLARED onboarding seeds (no session evidence). Soft + decaying; seedFacet never
// downgrades a facet behavior has already observed. Mirrors /observe's snapshot persistence.
profileRouter.post('/seed', async (req, res) => {
  try {
    const { candidates } = (req.body ?? {}) as { candidates?: any[] }
    if (!Array.isArray(candidates)) return res.status(400).json({ error: 'candidates[] required' })
    const now = Date.now()
    let seeded = 0
    for (const c of candidates) {
      if (!isDimension(c?.dimension) || !c?.facet_key || !c?.stance || !c?.statement) continue
      const valence = ['like', 'dislike', 'trait', 'neutral'].includes(c.valence) ? c.valence : 'neutral'
      seedFacet({ dimension: c.dimension, facet_key: String(c.facet_key), stance: String(c.stance),
        statement: String(c.statement), valence }, now)
      seeded++
    }
    if (seeded > 0) {
      try {
        if ((await mindStatus()).enabled) await persistProfileSnapshot(exportProfileSnapshot())
      } catch { /* persist is best-effort; the graph seed already succeeded */ }
    }
    res.json({ seeded })
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }) }
})

// POST /api/profile/narrative { text } — store the synthesized "about the human" prose.
profileRouter.post('/narrative', (req, res) => {
  try {
    const text = String((req.body ?? {}).text ?? '').trim()
    const now = Date.now()
    run(
      `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt)
       VALUES ('profile_narrative:user', 'Human profile narrative', 'profile_narrative', '', ?, 'profile', 'user', ?, ?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, updatedAt = excluded.updatedAt`,
      text, now, now,
    )
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }) }
})
