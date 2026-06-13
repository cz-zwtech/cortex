import { Router } from 'express'
import { all } from '../graph/db.js'
import { rowToObservation, type ObservationDTO } from '../graph/_rows.js'

export const observationsRouter = Router()

const TREND_ORDER: Record<string, number> = {
  strengthening: 0,
  stable: 1,
  weakening: 2,
  stale: 3,
}

/**
 * GET /api/observations
 *
 * Query params:
 *   scope    — exact scope match or scope prefix (e.g. "user:" or
 *              "session:-mnt-e-Repos-personal/")
 *   trend    — filter to a single trend value
 *   q        — substring match against observation name/description
 *   include_evidence — when "1", attach the list of source memory ids
 *   limit    — cap returned rows (default 50)
 *
 * Ordering: pinned first, then non-stale by trend then evidence_count
 * desc, with stale entries last.
 */
observationsRouter.get('/', async (req, res) => {
  const scope = typeof req.query.scope === 'string' ? req.query.scope : null
  const trendFilter = typeof req.query.trend === 'string' ? req.query.trend : null
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''
  const includeEvidence = req.query.include_evidence === '1'
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? '50') || 50))

  try {
    // Inner join entries × observation_meta by id — both rows are written for
    // every observation by ckn-derive. Filtering happens here so we don't
    // hydrate rows we'll throw away. scope STARTS WITH → `=` OR `LIKE prefix%`,
    // preserving the original exact-or-prefix match.
    const where: string[] = [`e.kind = 'observation'`]
    const params: any[] = []
    if (scope) {
      where.push(`(e.scope = ? OR e.scope LIKE ?)`)
      params.push(scope, scope + '%')
    }
    if (trendFilter) {
      where.push(`o.trend = ?`)
      params.push(trendFilter)
    }
    const rows = all<Record<string, any>>(
      `SELECT e.id AS id, e.name AS name, e.description AS description, ` +
        `       e.scope AS scope, e.updatedAt AS updatedAt, ` +
        `       o.trend AS trend, o.evidence_count AS evidence_count, ` +
        `       o.first_observed AS first_observed, o.last_observed AS last_observed, ` +
        `       o.observer AS observer, o.pinned AS pinned ` +
        `FROM entries e JOIN observation_meta o ON e.id = o.id ` +
        `WHERE ${where.join(' AND ')}`,
      ...params,
    )
    let obs: ObservationDTO[] = rows.map(rowToObservation)

    if (q) {
      obs = obs.filter(
        (o) => o.name.toLowerCase().includes(q) || o.description.toLowerCase().includes(q),
      )
    }

    obs.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const ta = TREND_ORDER[a.trend] ?? 5
      const tb = TREND_ORDER[b.trend] ?? 5
      if (ta !== tb) return ta - tb
      return b.evidence_count - a.evidence_count
    })
    obs = obs.slice(0, limit)

    if (includeEvidence && obs.length > 0) {
      const ids = obs.map((o) => o.id)
      const placeholders = ids.map(() => '?').join(', ')
      try {
        // DERIVED_FROM edges: observation (src) → source memory (dst).
        const er = all<{ oid: string; sid: string }>(
          `SELECT src AS oid, dst AS sid FROM edges ` +
            `WHERE rel = 'DERIVED_FROM' AND src IN (${placeholders})`,
          ...ids,
        )
        const bySrc = new Map<string, string[]>()
        for (const row of er) {
          if (!bySrc.has(row.oid)) bySrc.set(row.oid, [])
          bySrc.get(row.oid)!.push(row.sid)
        }
        for (const o of obs) o.evidence = bySrc.get(o.id) ?? []
      } catch {
        // DERIVED_FROM may be missing — surface observations without evidence
      }
    }

    res.json({ observations: obs })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})
