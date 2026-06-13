import { Router } from 'express'
import path from 'node:path'
import {
  DEFAULT_SHARED_PATH,
  enqueueItem,
  ensureClone,
  getManifest,
  publishQueue,
  readQueue,
  removeFromQueue,
  setRemote,
  status,
  sync,
  updateManifest,
  updateQueueItem,
  type SharedQueueItem,
} from '../sharedMind.js'
import { broadcastEvent } from '../watcher.js'
import { run, transaction } from '../graph/db.js'

export const sharedRouter = Router()

const resolveLocalPath = (raw?: string): string =>
  raw && raw.trim() ? raw.trim() : DEFAULT_SHARED_PATH

// ── status ───────────────────────────────────────────────────────────────────

// GET /api/shared/status?localPath=... — full snapshot for the UI panel.
sharedRouter.get('/status', async (req, res) => {
  const localPath = resolveLocalPath(req.query.localPath as string | undefined)
  try {
    const [s, queue, manifest] = await Promise.all([
      status(localPath),
      readQueue(localPath).catch(() => []),
      getManifest(localPath).catch(() => null),
    ])
    res.json({ status: s, queue, manifest })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/shared/init — create the working clone if needed; idempotent.
sharedRouter.post('/init', async (req, res) => {
  const localPath = resolveLocalPath((req.body ?? {}).localPath)
  try {
    await ensureClone(localPath)
    res.json({ ok: true, localPath })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/shared/remote — set or update origin URL.
sharedRouter.post('/remote', async (req, res) => {
  const { localPath, url } = (req.body ?? {}) as { localPath?: string; url?: string }
  if (!url) return res.status(400).json({ error: 'url required' })
  try {
    await setRemote(resolveLocalPath(localPath), url)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/shared/manifest — patch the manifest (name + description).
sharedRouter.post('/manifest', async (req, res) => {
  const { localPath, name, description } = (req.body ?? {}) as {
    localPath?: string
    name?: string
    description?: string
  }
  try {
    const m = await updateManifest(resolveLocalPath(localPath), { name, description })
    res.json({ manifest: m })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ── queue ────────────────────────────────────────────────────────────────────

// POST /api/shared/queue — body: { localPath?, item: SharedQueueItem }
sharedRouter.post('/queue', async (req, res) => {
  const { localPath, item } = (req.body ?? {}) as {
    localPath?: string
    item?: SharedQueueItem
  }
  if (!item || !item.id || !item.kind || !item.title) {
    return res.status(400).json({ error: 'item with id, kind, title required' })
  }
  try {
    const queue = await enqueueItem(resolveLocalPath(localPath), {
      ...item,
      queuedAt: item.queuedAt ?? Date.now(),
    })
    res.json({ queue })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/shared/queue/:id?localPath=...
sharedRouter.delete('/queue/:id(*)', async (req, res) => {
  const localPath = resolveLocalPath(req.query.localPath as string | undefined)
  try {
    const queue = await removeFromQueue(localPath, req.params.id!)
    res.json({ queue })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /api/shared/queue/:id — body: { localPath?, title?, description?, bodyOverride? }
// Refine an existing queue item before publish. Empty bodyOverride clears it.
sharedRouter.patch('/queue/:id(*)', async (req, res) => {
  const { localPath, title, description, bodyOverride } = (req.body ?? {}) as {
    localPath?: string
    title?: string
    description?: string
    bodyOverride?: string
  }
  try {
    const queue = await updateQueueItem(resolveLocalPath(localPath), req.params.id!, {
      title,
      description,
      bodyOverride,
    })
    res.json({ queue })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ── publish ──────────────────────────────────────────────────────────────────

// POST /api/shared/publish — drain queue, commit, push.
sharedRouter.post('/publish', async (req, res) => {
  const { localPath, message, publishedBy, push } = (req.body ?? {}) as {
    localPath?: string
    message?: string
    publishedBy?: string
    push?: boolean
  }
  try {
    const result = await publishQueue(resolveLocalPath(localPath), {
      message,
      publishedBy,
      push,
    })
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ── sync (pull + import memories into graph) ─────────────────────────────────

// POST /api/shared/sync — pull from origin, import memories under `shared:<name>` scope.
sharedRouter.post('/sync', async (req, res) => {
  const { localPath } = (req.body ?? {}) as { localPath?: string }
  const resolved = resolveLocalPath(localPath)
  try {
    const result = await sync(resolved)
    const manifest = await getManifest(resolved)
    const scope = `shared:${manifest.name}`

    const now = Date.now()
    let imported = 0
    let skipped = 0
    for (const m of result.memories) {
      try {
        // Parse simple frontmatter to lift name/description out of the body.
        const fmMatch = m.body.match(/^---\n([\s\S]*?)\n---\n?/)
        let body = m.body
        let name = m.name
        let description = ''
        let kind = 'memory'
        if (fmMatch) {
          const fm = fmMatch[1] ?? ''
          body = m.body.slice(fmMatch[0].length)
          const nameMatch = fm.match(/^name:\s*(.+)$/m)
          const descMatch = fm.match(/^description:\s*(.+)$/m)
          const typeMatch = fm.match(/^type:\s*(.+)$/m)
          if (nameMatch) name = nameMatch[1]!.trim()
          if (descMatch) description = descMatch[1]!.trim()
          if (typeMatch) kind = typeMatch[1]!.trim()
        }
        // Stable id: `<scope>/<filename>` so subsequent syncs upsert in place.
        const id = `${scope}/${path.basename(m.sourcePath, '.md')}`
        // Detach-delete then re-create (drop incident edges + the row, then
        // re-insert), atomic per memory.
        transaction(() => {
          run('DELETE FROM edges WHERE src = ? OR dst = ?', id, id)
          run('DELETE FROM entries WHERE id = ?', id)
          run(
            `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            name,
            kind,
            description,
            body.slice(0, 8192),
            m.sourcePath,
            scope,
            now,
            now,
          )
        })
        imported++
      } catch {
        skipped++
      }
    }
    // Divergence memories — same upsert pattern, different scope so they
    // don't pollute the main `shared:<name>` namespace. Each divergence
    // gets a kind based on the artifact type so Knowledge view can filter.
    let divergencesWritten = 0
    const divergenceScope = `${scope}:divergence`
    for (const d of result.divergences) {
      try {
        transaction(() => {
          run('DELETE FROM edges WHERE src = ? OR dst = ?', d.id, d.id)
          run('DELETE FROM entries WHERE id = ?', d.id)
          run(
            `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            d.id,
            d.title,
            `${d.kind}-divergence`,
            d.description,
            d.body.slice(0, 8192),
            d.localPaths.join(','),
            divergenceScope,
            now,
            now,
          )
        })
        divergencesWritten++
      } catch {
        // skip
      }
    }
    if (imported > 0 || divergencesWritten > 0) {
      broadcastEvent({
        type: 'graph:sync',
        source: 'shared-mind-sync',
        imported,
        divergences: divergencesWritten,
      })
    }
    res.json({
      pulled: result.pulled,
      pullError: result.pullError,
      imported,
      skipped,
      divergences: divergencesWritten,
      scope,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})
