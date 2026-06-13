import { Router } from 'express'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

export const filesRouter = Router()

// GET /api/files/read?path=...
filesRouter.get('/read', async (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) return res.status(400).json({ error: 'path required' })
  try {
    const contents = await fs.readFile(filePath, 'utf-8')
    res.json({ contents })
  } catch (e: any) {
    res.status(404).json({ error: e.message })
  }
})

// POST /api/files/write  { path, contents }
filesRouter.post('/write', async (req, res) => {
  const { path: filePath, contents } = req.body
  if (!filePath) return res.status(400).json({ error: 'path required' })
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, contents, 'utf-8')
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/files/write-json  { path, value }
filesRouter.post('/write-json', async (req, res) => {
  const { path: filePath, value } = req.body
  if (!filePath) return res.status(400).json({ error: 'path required' })
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8')
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/files/read-json?path=...
filesRouter.get('/read-json', async (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) return res.status(400).json({ error: 'path required' })
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    res.json({ value: JSON.parse(raw) })
  } catch (e: any) {
    res.status(404).json({ error: e.message })
  }
})

// GET /api/files/exists?path=...
filesRouter.get('/exists', async (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) return res.status(400).json({ error: 'path required' })
  res.json({ exists: fsSync.existsSync(filePath) })
})

// POST /api/files/ensure-dir  { path }
filesRouter.post('/ensure-dir', async (req, res) => {
  const { path: dirPath } = req.body
  try {
    await fs.mkdir(dirPath, { recursive: true })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/files/remove?path=...
filesRouter.delete('/remove', async (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) return res.status(400).json({ error: 'path required' })
  try {
    await fs.rm(filePath, { recursive: true, force: true })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/files/rename  { from, to }
filesRouter.post('/rename', async (req, res) => {
  const { from, to } = req.body
  try {
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.rename(from, to)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/files/list?path=...
filesRouter.get('/list', async (req, res) => {
  const dirPath = req.query.path as string
  if (!dirPath) return res.status(400).json({ error: 'path required' })
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const result = await Promise.all(
      entries.map(async (e) => {
        const full = path.join(dirPath, e.name)
        let mtime = 0, size = 0
        try {
          const stat = await fs.stat(full)
          mtime = stat.mtimeMs
          size = stat.size
        } catch {}
        return {
          name: e.name,
          path: full,
          is_dir: e.isDirectory(),
          is_file: e.isFile(),
          mtime,
          size,
        }
      })
    )
    res.json({ entries: result })
  } catch (e: any) {
    res.status(404).json({ error: e.message })
  }
})

// GET /api/files/list-recursive?path=...&maxDepth=...
filesRouter.get('/list-recursive', async (req, res) => {
  const dirPath = req.query.path as string
  const maxDepth = parseInt(req.query.maxDepth as string) || 5
  if (!dirPath) return res.status(400).json({ error: 'path required' })

  const results: any[] = []
  const SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.next'])

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return
    let entries: any[]
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const full = path.join(dir, e.name)
      let mtime = 0, size = 0
      try { const s = await fs.stat(full); mtime = s.mtimeMs; size = s.size } catch {}
      results.push({ name: e.name, path: full, is_dir: e.isDirectory(), is_file: e.isFile(), mtime, size })
      if (e.isDirectory()) await walk(full, depth + 1)
    }
  }

  await walk(dirPath, 0)
  res.json({ entries: results })
})

// GET /api/files/find?root=...&name=...&maxDepth=...
filesRouter.get('/find', async (req, res) => {
  const root = req.query.root as string
  const name = req.query.name as string
  const maxDepth = parseInt(req.query.maxDepth as string) || 8
  if (!root || !name) return res.status(400).json({ error: 'root and name required' })

  const results: any[] = []
  const SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.next'])

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return
    let entries: any[]
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isFile() && e.name === name) {
        let mtime = 0, size = 0
        try { const s = await fs.stat(full); mtime = s.mtimeMs; size = s.size } catch {}
        results.push({ name: e.name, path: full, is_dir: false, is_file: true, mtime, size })
      }
      if (e.isDirectory()) await walk(full, depth + 1)
    }
  }

  await walk(root, 0)
  res.json({ entries: results })
})

// POST /api/files/scan-projects  { root, maxDepth }
filesRouter.post('/scan-projects', async (req, res) => {
  const { root, maxDepth = 5 } = req.body
  if (!root) return res.status(400).json({ error: 'root required' })

  const hits: any[] = []
  const SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.next'])

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return
    let entries: any[]
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    const names = new Set(entries.map(e => e.name))
    const hasClaude = names.has('CLAUDE.md') || names.has('claude.md')
    const hasDir = names.has('.claude')
    if (hasClaude || hasDir) {
      hits.push({ path: dir, has_claude_md: hasClaude, has_claude_dir: hasDir })
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name)) {
        await walk(path.join(dir, e.name), depth + 1)
      }
    }
  }

  await walk(root, 0)
  res.json({ hits })
})
