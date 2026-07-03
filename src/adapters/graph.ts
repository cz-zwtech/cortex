const BASE = '/api/graph'

export interface GraphEntry {
  id: string
  name: string
  kind: string
  description: string
  scope: string
  updatedAt: number
  syncedAt?: number
}

export interface GraphLink {
  id: string
  name: string
  kind: string
  label: string
}

export interface GraphEntryDetail extends GraphEntry {
  content: string
  source: string
  links: GraphLink[]
  backlinks: GraphLink[]
}

export interface GraphStats {
  nodes: number
  edges: number
  lastSync: number | null
  previousSync: number | null
}

export async function graphStats(): Promise<GraphStats> {
  const res = await fetch(`${BASE}/stats`)
  return res.json()
}

export async function graphSearch(q: string, limit = 30): Promise<GraphEntry[]> {
  if (!q.trim()) return []
  const res = await fetch(`${BASE}/search?q=${encodeURIComponent(q)}&limit=${limit}`)
  const data = await res.json()
  return data.entries ?? []
}

export async function graphListRecent(
  limit = 40,
  opts: {
    since?: number
    syncedSince?: number
    sort?: 'updated' | 'synced'
    scope?: string
    kind?: string
    machine?: string
  } = {},
): Promise<GraphEntry[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (opts.since) params.set('since', String(opts.since))
  if (opts.syncedSince) params.set('syncedSince', String(opts.syncedSince))
  if (opts.sort) params.set('sort', opts.sort)
  if (opts.scope) params.set('scope', opts.scope)
  if (opts.kind) params.set('kind', opts.kind)
  if (opts.machine) params.set('machine', opts.machine)
  const res = await fetch(`${BASE}/nodes?${params}`)
  const data = await res.json()
  return data.entries ?? []
}

export async function graphGetEntry(id: string): Promise<GraphEntryDetail | null> {
  const res = await fetch(`${BASE}/node/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  return res.json()
}

export async function graphSync(): Promise<{ synced: number; skipped: number; errors: string[] }> {
  const res = await fetch(`${BASE}/sync`, { method: 'POST' })
  return res.json()
}

export interface GraphNode {
  id: string
  name: string
  kind: string
  scope: string
}

export interface GraphEdge {
  from: string
  to: string
  // #126: getAllForGraph now exports every entries<->entries edge carrying its
  // relation type, so the view can colour/filter by rel. Optional: symbol-overlay
  // edges may omit it and fall back to the default colour.
  rel?: string
  label: string
}

export async function graphAll(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const res = await fetch(`${BASE}/all`)
  return res.json()
}

export async function graphImportVault(
  vaultName: string,
  targets: string[],
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const res = await fetch(`${BASE}/import-vault`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vaultName, targets }),
  })
  return res.json()
}

export async function graphListScopes(): Promise<{ scope: string; count: number }[]> {
  const res = await fetch(`${BASE}/scopes`)
  const data = await res.json()
  return (data.scopes ?? []).map((r: any) => ({ scope: r.scope, count: Number(r.count) }))
}

export async function graphListKinds(): Promise<{ kind: string; count: number }[]> {
  const res = await fetch(`${BASE}/kinds`)
  const data = await res.json()
  return (data.kinds ?? []).map((r: any) => ({ kind: r.kind, count: Number(r.count) }))
}

export async function graphDeleteScope(scope: string): Promise<{ removed: number }> {
  const res = await fetch(`${BASE}/scope/${encodeURIComponent(scope)}`, { method: 'DELETE' })
  return res.json()
}

// ── Code-graph symbols ───────────────────────────────────────────────────────

export interface GraphSymbol {
  id: string
  name: string
  symbolKind: string
  repo: string
  file: string
  lang: string
  line: number
  signature: string
  base: number
  stickiness: number
  centrality: number
  lastSeen: number
  pinned: boolean
  groundTruthValid: boolean
  /** Origin machine id (lineage). Empty if pre-lineage. */
  machine: string
  /**
   * Absolute filesystem root the extractor walked, per repo. Join with `file`
   * (repo-relative) for the real on-disk path. Empty until re-ingested on an
   * install that has the 0012 migration.
   */
  root: string
}

export async function graphListSymbols(
  opts: { repo?: string; limit?: number; machine?: string } = {},
): Promise<GraphSymbol[]> {
  const params = new URLSearchParams()
  if (opts.repo) params.set('repo', opts.repo)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.machine) params.set('machine', opts.machine)
  const qs = params.toString()
  const res = await fetch(`${BASE}/symbols${qs ? `?${qs}` : ''}`)
  if (!res.ok) return []
  const data = await res.json()
  return data.symbols ?? []
}

export interface SymbolNeighborhood {
  symbol: GraphSymbol | null
  dependents: GraphSymbol[]
  dependencies: GraphSymbol[]
}

/**
 * The full symbol graph as `{ nodes, edges }` for the memory-graph overlay.
 * Nodes are tagged `kind: 'symbol'`; edges use the GraphCanvas `{from,to,label}`
 * shape (label = edge kind). Fetched lazily — only when the overlay is enabled.
 */
export async function graphSymbolGraph(
  repo?: string,
  machine?: string,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const params = new URLSearchParams()
  if (repo) params.set('repo', repo)
  if (machine) params.set('machine', machine)
  const qs = params.toString()
  const res = await fetch(`${BASE}/symbols/graph${qs ? `?${qs}` : ''}`)
  if (!res.ok) return { nodes: [], edges: [] }
  return res.json()
}

// ── Code-view subgraph (Code view empty-state visualization) ─────────────────

export type SubgraphEdgeKind = 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'IMPLEMENTS' | 'REFERENCES'

export interface SubgraphModuleNode {
  type: 'module'
  id: string
  file: string
  symbolCount: number
}
export interface SubgraphSymbolNode {
  type: 'symbol'
  id: string
  name: string
  symbolKind: string
  file: string
  line: number
  centrality: number
  groundTruthValid: boolean
}
export type SubgraphNode = SubgraphModuleNode | SubgraphSymbolNode

export interface SubgraphEdge {
  from: string
  to: string
  kind: SubgraphEdgeKind
  weight?: number
}

export interface SymbolSubgraph {
  repo: string
  branch: string
  mode: 'modules' | 'symbols' | 'all'
  truncated: boolean
  totalSymbols: number
  nodes: SubgraphNode[]
  edges: SubgraphEdge[]
}

const EMPTY_SUBGRAPH = (repo: string): SymbolSubgraph => ({
  repo,
  branch: '',
  mode: 'symbols',
  truncated: false,
  totalSymbols: 0,
  nodes: [],
  edges: [],
})

/**
 * Capped, branch-resolved code subgraph for the Code-view empty state. Returns
 * an empty subgraph (never throws) on error so the viz degrades to "nothing to
 * show" rather than crashing the view.
 */
export async function graphSymbolSubgraph(opts: {
  repo: string
  branch?: string
  machine?: string
  topN?: number
  mode?: 'modules' | 'symbols' | 'all'
}): Promise<SymbolSubgraph> {
  const params = new URLSearchParams({ repo: opts.repo })
  if (opts.branch !== undefined) params.set('branch', opts.branch)
  if (opts.machine) params.set('machine', opts.machine)
  if (opts.topN !== undefined) params.set('topN', String(opts.topN))
  if (opts.mode) params.set('mode', opts.mode)
  try {
    const res = await fetch(`${BASE}/symbols/subgraph?${params}`)
    if (!res.ok) return EMPTY_SUBGRAPH(opts.repo)
    return await res.json()
  } catch {
    return EMPTY_SUBGRAPH(opts.repo)
  }
}

export interface SymbolView {
  repo: string
  branch: string
  machine: string
  symbols: number
  lastSyncedAt: number
  commitSha: string
  dirty: boolean
}

/** Distinct (repo, branch, machine) symbol coordinates with counts. */
export async function graphSymbolViews(): Promise<SymbolView[]> {
  try {
    const res = await fetch(`${BASE}/symbols/views`)
    if (!res.ok) return []
    const data = await res.json()
    return (data.views ?? []) as SymbolView[]
  } catch {
    return []
  }
}

/** The user-pinned Code-view display branch for a repo, or null. */
export async function graphGetDefaultBranch(repo: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/symbols/default-branch?repo=${encodeURIComponent(repo)}`)
    if (!res.ok) return null
    const data = await res.json()
    return (data.branch ?? null) as string | null
  } catch {
    return null
  }
}

/** Pin (branch) or clear (branch=null) the Code-view default display branch. */
export async function graphSetDefaultBranch(
  repo: string,
  branch: string | null,
): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/symbols/default-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, branch }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return (data.branch ?? null) as string | null
  } catch {
    return null
  }
}

export async function graphSymbolNeighborhood(
  id: string,
  kinds?: string[],
): Promise<SymbolNeighborhood | null> {
  const qs = kinds && kinds.length ? `?kinds=${kinds.join(',')}` : ''
  const res = await fetch(`${BASE}/symbols/${encodeURIComponent(id)}/dependents${qs}`)
  if (!res.ok) return null
  return res.json()
}

export interface MachineInfo {
  machineId: string        // = canonicalId (kept name to minimize view churn)
  hostname: string
  isSelf: boolean
  status: 'live' | 'idle' | 'dormant'
  lastContact: number
  sessionCount: number
  memoryCount: number
  symbolCount: number
}

export const graphListMachines = async (): Promise<{
  self: string
  remote: string | null
  retiredCount: number
  machines: MachineInfo[]
}> => {
  const r = await fetch(`/api/machines`)
  if (!r.ok) throw new Error(`machines ${r.status}`)
  const data = await r.json()
  return {
    self: data.self,
    remote: data.remote ?? null,
    retiredCount: data.retiredCount ?? 0,
    machines: (data.machines ?? []).map((m: any) => ({
      machineId: m.canonicalId,
      hostname: m.hostname,
      isSelf: m.isSelf,
      status: m.status,
      lastContact: m.lastContact,
      sessionCount: m.sessionCount,
      memoryCount: m.memoryCount,
      symbolCount: m.symbolCount,
    })),
  }
}

/**
 * Forget an entire repo's symbol subgraph locally and (when private-mind is
 * enabled) propagate the removal across machines. Destructive.
 */
export async function graphForgetRepoSymbols(
  repo: string,
): Promise<{ removed: number; federated: boolean }> {
  const res = await fetch(`${BASE}/symbols/forget`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo }),
  })
  if (!res.ok) return { removed: 0, federated: false }
  return res.json()
}
