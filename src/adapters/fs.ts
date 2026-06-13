import { recordSelfWrite } from './selfWrites'

const API = '/api'

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${API}${path}`, window.location.origin)
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = await fetch(url.toString(), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? res.statusText)
  }
  return res.json() as Promise<T>
}

export interface DirEntry {
  name: string
  path: string
  is_dir: boolean
  is_file: boolean
  mtime: number
  size: number
}

export interface FsChange {
  kind: 'create' | 'modify' | 'remove' | 'other'
  paths: string[]
}

export interface ProjectHit {
  path: string
  has_claude_md: boolean
  has_claude_dir: boolean
}

// WebSocket for live file-change events
let watchWs: WebSocket | null = null
let changeCallbacks: Array<(ev: FsChange) => void> = []

function getWatchSocket(): WebSocket {
  if (watchWs && watchWs.readyState === WebSocket.OPEN) return watchWs
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  watchWs = new WebSocket(`${proto}//${window.location.host}/ws?type=watch`)
  watchWs.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      if (data.type === 'fs:change') {
        const ev: FsChange = { kind: data.kind, paths: data.paths }
        changeCallbacks.forEach((cb) => cb(ev))
      }
    } catch {}
  }
  watchWs.onclose = () => { watchWs = null }
  return watchWs
}

export const fs = {
  homeDir: async (): Promise<string> => {
    const { home } = await api<{ home: string }>('GET', '/home')
    return home
  },

  readText: async (path: string): Promise<string> => {
    const { contents } = await api<{ contents: string }>('GET', '/files/read', undefined, { path })
    return contents
  },

  writeText: async (path: string, contents: string): Promise<void> => {
    recordSelfWrite(path)
    await api('POST', '/files/write', { path, contents })
  },

  readJson: async <T = unknown>(path: string): Promise<T> => {
    const { value } = await api<{ value: T }>('GET', '/files/read-json', undefined, { path })
    return value
  },

  writeJson: async (path: string, value: unknown): Promise<void> => {
    recordSelfWrite(path)
    await api('POST', '/files/write-json', { path, value })
  },

  pathExists: async (path: string): Promise<boolean> => {
    const { exists } = await api<{ exists: boolean }>('GET', '/files/exists', undefined, { path })
    return exists
  },

  ensureDir: async (path: string): Promise<void> => {
    await api('POST', '/files/ensure-dir', { path })
  },

  removePath: async (path: string): Promise<void> => {
    recordSelfWrite(path)
    await api('DELETE', `/files/remove`, undefined, { path })
  },

  renamePath: async (from: string, to: string): Promise<void> => {
    recordSelfWrite(from)
    recordSelfWrite(to)
    await api('POST', '/files/rename', { from, to })
  },

  listDir: async (path: string): Promise<DirEntry[]> => {
    const { entries } = await api<{ entries: DirEntry[] }>('GET', '/files/list', undefined, { path })
    return entries
  },

  listDirRecursive: async (path: string, maxDepth?: number): Promise<DirEntry[]> => {
    const params: Record<string, string> = { path }
    if (maxDepth !== undefined) params.maxDepth = String(maxDepth)
    const { entries } = await api<{ entries: DirEntry[] }>('GET', '/files/list-recursive', undefined, params)
    return entries
  },

  findFilesNamed: async (root: string, name: string, maxDepth?: number): Promise<DirEntry[]> => {
    const params: Record<string, string> = { root, name }
    if (maxDepth !== undefined) params.maxDepth = String(maxDepth)
    const { entries } = await api<{ entries: DirEntry[] }>('GET', '/files/find', undefined, params)
    return entries
  },

  watchPaths: async (paths: string[]): Promise<void> => {
    const ws = getWatchSocket()
    const send = () => ws.send(JSON.stringify({ type: 'watch', paths }))
    if (ws.readyState === WebSocket.OPEN) send()
    else ws.addEventListener('open', send, { once: true })
  },

  unwatchAll: async (): Promise<void> => {
    // Server-side watcher persists; just drop callbacks
    changeCallbacks = []
  },

  scanForProjects: async (root: string, maxDepth?: number): Promise<ProjectHit[]> => {
    const { hits } = await api<{ hits: ProjectHit[] }>('POST', '/files/scan-projects', { root, maxDepth })
    return hits
  },

  onChange: async (cb: (ev: FsChange) => void): Promise<() => void> => {
    changeCallbacks.push(cb)
    getWatchSocket() // ensure connected
    return () => {
      changeCallbacks = changeCallbacks.filter((f) => f !== cb)
    }
  },

  runClaudeCli: async (
    args: string[],
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; exit_code: number }> => {
    return api('POST', '/shell/run', { cmd: 'claude', args, timeoutMs })
  },

  openExternal: async (target: string): Promise<void> => {
    // Best effort — open in new tab
    window.open(target, '_blank', 'noopener')
  },
}

export const readTextOrNull = async (path: string): Promise<string | null> => {
  try { return await fs.readText(path) } catch { return null }
}

export const readJsonOrNull = async <T = unknown>(path: string): Promise<T | null> => {
  try { return await fs.readJson<T>(path) } catch { return null }
}

export const join = (...parts: string[]): string =>
  parts
    .filter(Boolean)
    .map((p) => p.replace(/[\/\\]+$/, ''))
    .join('/')
    .replace(/\/+/g, '/')

export const basename = (p: string): string =>
  p.replace(/[\/\\]+$/, '').split(/[\/\\]/).pop() ?? p

export const dirname = (p: string): string => {
  const parts = p.replace(/\\/g, '/').split('/')
  parts.pop()
  return parts.join('/') || '/'
}

export const stripExt = (name: string, ext: string): string =>
  name.endsWith(ext) ? name.slice(0, -ext.length) : name
