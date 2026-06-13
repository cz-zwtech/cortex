import { Router } from 'express'
import { compileCapabilitySheet } from '../capabilitySheet.js'

export const capabilityRouter = Router()

/**
 * GET /api/capability/sheet?cwd=<path>
 *
 * Returns a structured capability sheet — skills, MCP servers, permissions,
 * sub-agents — with both raw `data` and a rendered `markdown` block.
 *
 * The SessionStart hook script calls this and emits the markdown as
 * `additionalContext` so Claude sees its capabilities from turn 1. `cwd` is
 * optional; when present, project-scope `.claude/` is included alongside
 * user scope.
 */
capabilityRouter.get('/sheet', async (req, res) => {
  const cwd = (req.query.cwd as string) || undefined
  try {
    const { data, markdown } = await compileCapabilitySheet(cwd)
    res.json({ data, markdown })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})
