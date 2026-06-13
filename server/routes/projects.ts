import { Router } from 'express'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const projectsRouter = Router()

const claudeJsonPath = () => path.join(os.homedir(), '.claude.json')

// GET /api/projects — list projects from ~/.claude.json
projectsRouter.get('/', async (_req, res) => {
  try {
    const raw = await fs.readFile(claudeJsonPath(), 'utf-8')
    const data = JSON.parse(raw)
    const projects = Object.keys(data.projects ?? {})
    res.json({ projects })
  } catch {
    res.json({ projects: [] })
  }
})

// POST /api/projects/add  { path }
projectsRouter.post('/add', async (req, res) => {
  const { path: projectPath } = req.body
  if (!projectPath) return res.status(400).json({ error: 'path required' })
  try {
    let data: any = {}
    try {
      const raw = await fs.readFile(claudeJsonPath(), 'utf-8')
      data = JSON.parse(raw)
    } catch {}
    if (!data.projects) data.projects = {}
    data.projects[projectPath] = data.projects[projectPath] ?? {}
    await fs.writeFile(claudeJsonPath(), JSON.stringify(data, null, 2))
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/projects/remove?path=...
projectsRouter.delete('/remove', async (req, res) => {
  const projectPath = req.query.path as string
  if (!projectPath) return res.status(400).json({ error: 'path required' })
  try {
    const raw = await fs.readFile(claudeJsonPath(), 'utf-8')
    const data = JSON.parse(raw)
    delete data.projects?.[projectPath]
    await fs.writeFile(claudeJsonPath(), JSON.stringify(data, null, 2))
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})
