/**
 * Client adapter for the shared-mind feature.
 *
 * Wraps `/api/shared/*` endpoints. The store calls these to manage the
 * publish queue, push to the remote, and sync from upstream.
 */
const BASE = '/api/shared'

export interface SharedQueueItem {
  id: string
  kind:
    | 'memory'
    | 'skill'
    | 'agent'
    | 'command'
    | 'rule'
    | 'permission'
    | 'hook'
    | 'mcp'
  title: string
  description?: string
  payload: Record<string, any>
  sourcePath?: string
  bodyOverride?: string
  queuedAt: number
}

export interface SharedStatus {
  localPath: string
  remoteUrl: string | null
  initialized: boolean
  hasRemote: boolean
  branch: string | null
  ahead: number
  behind: number
  dirty: boolean
  lastSyncMs: number | null
  memoryCount: number
  artifactCount: number
}

export interface SharedManifest {
  schemaVersion: 1
  name: string
  description?: string
  contributors?: string[]
  lastSyncMs?: number
}

export interface PublishResult {
  itemsWritten: number
  filesCommitted: number
  pushed: boolean
  pushError: string | null
  commitSha: string | null
}

export interface SyncResult {
  pulled: boolean
  pullError: string | null
  imported: number
  skipped: number
  scope: string
}

const qsLocal = (localPath?: string): string =>
  localPath ? `?localPath=${encodeURIComponent(localPath)}` : ''

export const sharedStatus = async (
  localPath?: string,
): Promise<{ status: SharedStatus; queue: SharedQueueItem[]; manifest: SharedManifest | null }> => {
  const res = await fetch(`${BASE}/status${qsLocal(localPath)}`)
  return res.json()
}

export const sharedInit = async (localPath?: string): Promise<void> => {
  await fetch(`${BASE}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ localPath }),
  })
}

export const sharedSetRemote = async (url: string, localPath?: string): Promise<void> => {
  const res = await fetch(`${BASE}/remote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, localPath }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? 'set remote failed')
  }
}

export const sharedSetManifest = async (
  patch: { name?: string; description?: string },
  localPath?: string,
): Promise<SharedManifest> => {
  const res = await fetch(`${BASE}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...patch, localPath }),
  })
  const data = await res.json()
  return data.manifest
}

export const sharedQueueAdd = async (
  item: SharedQueueItem,
  localPath?: string,
): Promise<SharedQueueItem[]> => {
  const res = await fetch(`${BASE}/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item, localPath }),
  })
  const data = await res.json()
  return data.queue ?? []
}

export const sharedQueueRemove = async (
  id: string,
  localPath?: string,
): Promise<SharedQueueItem[]> => {
  const res = await fetch(`${BASE}/queue/${encodeURIComponent(id)}${qsLocal(localPath)}`, {
    method: 'DELETE',
  })
  const data = await res.json()
  return data.queue ?? []
}

export const sharedQueueUpdate = async (
  id: string,
  patch: { title?: string; description?: string; bodyOverride?: string },
  localPath?: string,
): Promise<SharedQueueItem[]> => {
  const res = await fetch(`${BASE}/queue/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...patch, localPath }),
  })
  const data = await res.json()
  return data.queue ?? []
}

export const sharedPublish = async (
  opts: { message?: string; publishedBy?: string; push?: boolean; localPath?: string } = {},
): Promise<PublishResult> => {
  const res = await fetch(`${BASE}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  return res.json()
}

export const sharedSync = async (localPath?: string): Promise<SyncResult> => {
  const res = await fetch(`${BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ localPath }),
  })
  return res.json()
}
