import { Router } from 'express'
import { listSessions, readSessionRange } from '../sessions.js'

export const sessionsRouter = Router()

// GET /api/sessions/list — every session JSONL across every project, with metadata
sessionsRouter.get('/list', async (_req, res) => {
  try {
    const sessions = await listSessions()
    res.json({ sessions })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/sessions/:projectDir/:id?sinceLine=<n> — parsed messages from offset N.
// projectDir uses Claude's encoded path form (e.g. -mnt-e-Repos-personal).
sessionsRouter.get('/:projectDir/:id', async (req, res) => {
  const { projectDir, id } = req.params
  const sinceLine = req.query.sinceLine ? parseInt(req.query.sinceLine as string, 10) : 0
  const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string, 10), 5000) : 5000
  try {
    const result = await readSessionRange(projectDir, id, sinceLine, limit)
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})
