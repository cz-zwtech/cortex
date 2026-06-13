import { Router } from 'express'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const obsidianRouter = Router()

// Detect WSL — process.platform reports 'linux' but we may want Windows paths
function isWSL(): boolean {
  try {
    const procVersion = fsSync.readFileSync('/proc/version', 'utf-8')
    return /microsoft|wsl/i.test(procVersion)
  } catch {
    return false
  }
}

// Obsidian stores its vault list in a platform-specific config file.
// On WSL we also probe the Windows AppData path under /mnt/c/Users/*.
function obsidianConfigPaths(): string[] {
  const paths: string[] = []
  if (process.platform === 'win32') {
    paths.push(path.join(process.env.APPDATA ?? os.homedir(), 'obsidian', 'obsidian.json'))
  } else {
    paths.push(path.join(os.homedir(), '.config', 'obsidian', 'obsidian.json'))
  }
  if (isWSL()) {
    // Probe likely Windows user dirs under /mnt/c/Users/*/AppData/Roaming/obsidian/obsidian.json
    try {
      const usersDir = '/mnt/c/Users'
      const users = fsSync.readdirSync(usersDir, { withFileTypes: true })
      for (const u of users) {
        if (!u.isDirectory()) continue
        if (u.name === 'Public' || u.name === 'Default' || u.name.startsWith('.')) continue
        paths.push(path.join(usersDir, u.name, 'AppData', 'Roaming', 'obsidian', 'obsidian.json'))
      }
    } catch {
      // ignore — /mnt/c may not be mounted
    }
  }
  return paths
}

// GET /api/obsidian/vaults — discover installed Obsidian vaults across all known config locations
obsidianRouter.get('/vaults', async (_req, res) => {
  const cfgPaths = obsidianConfigPaths()
  const vaults: { id: string | null; path: string; name: string }[] = []
  let anyConfigFound = false

  for (const cfgPath of cfgPaths) {
    if (!fsSync.existsSync(cfgPath)) continue
    anyConfigFound = true
    try {
      const raw = await fs.readFile(cfgPath, 'utf-8')
      const data = JSON.parse(raw)
      for (const [id, v] of Object.entries((data.vaults ?? {}) as Record<string, any>)) {
        let vaultPath = v.path as string
        // Translate Windows-style paths to WSL /mnt/<drive>/...
        if (isWSL() && /^[A-Za-z]:[\\/]/.test(vaultPath)) {
          const drive = vaultPath[0]!.toLowerCase()
          vaultPath = '/mnt/' + drive + vaultPath.slice(2).replace(/\\/g, '/')
        }
        vaults.push({ id: v.id ?? id, path: vaultPath, name: path.basename(vaultPath) })
      }
    } catch {
      // skip unreadable config
    }
  }

  // De-dupe by path
  const seen = new Set<string>()
  const unique = vaults.filter((v) => {
    if (seen.has(v.path)) return false
    seen.add(v.path)
    return true
  })

  res.json({ vaults: unique, detected: anyConfigFound })
})

// POST /api/obsidian/validate  { path } — confirm a directory looks like an Obsidian vault
obsidianRouter.post('/validate', async (req, res) => {
  const { path: vaultPath } = req.body
  if (!vaultPath) return res.status(400).json({ error: 'path required' })
  const obsidianDir = path.join(vaultPath, '.obsidian')
  const valid = fsSync.existsSync(obsidianDir)
  res.json({ valid })
})
