import { Router } from 'express'
import { deriveObservations, type DeriveOptions } from '../graph/derive.js'
import { withGraphWriteLock } from '../graph/db.js'

export const deriveRouter = Router()

/**
 * POST /api/derive — runs the observation derivation pass in-process
 * so the server's existing graph connection (which holds the file lock)
 * is reused. External CLI callers (bin/ckn-derive.ts) should hit this
 * endpoint instead of opening a competing connection.
 *
 * Body: { scope?, minCluster?, cosineMin?, dryRun? } — all optional.
 */
deriveRouter.post('/', async (req, res) => {
  const body = (req.body ?? {}) as DeriveOptions
  try {
    const opts: DeriveOptions = {
      scope: typeof body.scope === 'string' ? body.scope : null,
      minCluster: Number.isFinite(body.minCluster as number) ? Number(body.minCluster) : undefined,
      cosineMin: Number.isFinite(body.cosineMin as number) ? Number(body.cosineMin) : undefined,
      dryRun: body.dryRun === true,
    }
    // dry-run is read-only; only take the write lock when actually writing.
    const result = opts.dryRun
      ? await deriveObservations(opts)
      : await withGraphWriteLock('derive', () => deriveObservations(opts))
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})
