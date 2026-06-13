/**
 * Pure layout for the Code-view AST graph empty state. Deterministic — NO
 * physics. Symbols are grouped into per-file containers and placed into
 * left-to-right tiers by dependency depth (longest path), so a symbol sits to
 * the right of everything it depends on. This is the structural counterpoint to
 * the memory GraphView's D3 force simulation.
 *
 * No React / no DOM here so it can be unit-tested under tsx. The type import is
 * relative + type-only (erased at runtime) so the tsx runner never hits Vite's
 * `@/` path alias.
 */
import type { SubgraphNode, SubgraphEdge, SubgraphEdgeKind } from '../../adapters/graph'

export interface LayoutInput {
  nodes: SubgraphNode[]
  edges: SubgraphEdge[]
}

export interface PositionedNode {
  id: string
  type: 'module' | 'symbol'
  label: string // name (symbol) or file (module)
  file: string
  symbolKind?: string // symbol only
  centrality?: number // symbol only
  groundTruthValid: boolean
  tier: number
  x: number
  y: number
  r: number // node radius (module nodes scale with symbolCount)
}

export interface PositionedEdge {
  from: string
  to: string
  kind: SubgraphEdgeKind
  weight?: number
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface Container {
  file: string
  nodeIds: string[]
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutResult {
  nodes: PositionedNode[]
  edges: PositionedEdge[]
  containers: Container[]
  width: number
  height: number
}

const TIER_GAP = 460 // horizontal px between tiers
const ROW_GAP = 92 // vertical px between nodes in a tier
const PAD = 48
const labelOf = (n: SubgraphNode): string => (n.type === 'symbol' ? n.name : n.file)
const radiusOf = (n: SubgraphNode): number =>
  n.type === 'module' ? Math.min(28, 10 + Math.sqrt(n.symbolCount) * 3) : 9

/**
 * Longest-path tier per node: a node's tier is 1 + the max tier of the nodes it
 * depends on (its out-edge targets). Pure sinks (no out-edges) are tier 0.
 * Cycle-safe: memoized DFS with an on-stack guard that treats a back-edge as
 * contributing tier 0, so a cycle terminates with finite tiers.
 */
function assignTiers(nodes: SubgraphNode[], edges: SubgraphEdge[]): Map<string, number> {
  const present = new Set(nodes.map((n) => n.id))
  const out = new Map<string, string[]>()
  for (const n of nodes) out.set(n.id, [])
  for (const e of edges) {
    if (present.has(e.from) && present.has(e.to)) out.get(e.from)!.push(e.to)
  }
  const tier = new Map<string, number>()
  const onStack = new Set<string>()
  const visit = (id: string): number => {
    if (tier.has(id)) return tier.get(id)!
    if (onStack.has(id)) return 0 // back-edge: break the cycle
    onStack.add(id)
    let best = 0
    for (const dep of out.get(id)!) best = Math.max(best, visit(dep) + 1)
    onStack.delete(id)
    tier.set(id, best)
    return best
  }
  for (const n of nodes) visit(n.id)
  return tier
}

export function layoutCodeGraph(
  input: LayoutInput,
  viewport: { width: number; height: number },
): LayoutResult {
  const tiers = assignTiers(input.nodes, input.edges)

  // Group nodes by tier, then order within a tier by file (keeps a file's
  // symbols vertically adjacent) then centrality desc.
  const byTier = new Map<number, SubgraphNode[]>()
  for (const n of input.nodes) {
    const t = tiers.get(n.id) ?? 0
    const arr = byTier.get(t) ?? []
    arr.push(n)
    byTier.set(t, arr)
  }
  for (const arr of byTier.values()) {
    arr.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      const ca = a.type === 'symbol' ? a.centrality : -1
      const cb = b.type === 'symbol' ? b.centrality : -1
      return cb - ca
    })
  }

  const positioned: PositionedNode[] = []
  const posById = new Map<string, PositionedNode>()
  const maxTier = Math.max(0, ...[...byTier.keys()])
  for (let t = 0; t <= maxTier; t++) {
    const arr = byTier.get(t) ?? []
    const x = PAD + t * TIER_GAP
    arr.forEach((n, i) => {
      const p: PositionedNode = {
        id: n.id,
        type: n.type,
        label: labelOf(n),
        file: n.file,
        symbolKind: n.type === 'symbol' ? n.symbolKind : undefined,
        centrality: n.type === 'symbol' ? n.centrality : undefined,
        groundTruthValid: n.type === 'symbol' ? n.groundTruthValid : true,
        tier: t,
        x,
        y: PAD + i * ROW_GAP,
        r: radiusOf(n),
      }
      positioned.push(p)
      posById.set(p.id, p)
    })
  }

  // File containers: bounding box over a file's nodes.
  const fileMap = new Map<string, PositionedNode[]>()
  for (const p of positioned) {
    const arr = fileMap.get(p.file) ?? []
    arr.push(p)
    fileMap.set(p.file, arr)
  }
  const containers: Container[] = [...fileMap.entries()]
    .map(([file, ns]) => {
      const xs = ns.map((n) => n.x)
      const ys = ns.map((n) => n.y)
      const minX = Math.min(...xs) - 22
      const maxX = Math.max(...xs) + 22
      const minY = Math.min(...ys) - 22
      const maxY = Math.max(...ys) + 22
      return { file, nodeIds: ns.map((n) => n.id), x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    })
    .sort((a, b) => (a.file < b.file ? -1 : 1))

  const edges: PositionedEdge[] = []
  for (const e of input.edges) {
    const a = posById.get(e.from)
    const b = posById.get(e.to)
    if (!a || !b) continue
    edges.push({ from: e.from, to: e.to, kind: e.kind, weight: e.weight, x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  }

  const contentW = PAD * 2 + maxTier * TIER_GAP
  const contentH = PAD * 2 + Math.max(0, ...[...byTier.values()].map((a) => a.length)) * ROW_GAP
  return {
    nodes: positioned,
    edges,
    containers,
    width: Math.max(viewport.width, contentW),
    height: Math.max(viewport.height, contentH),
  }
}

/** Edge kind → tone + dash pattern. Distinct from the memory graph's palette. */
export const EDGE_STYLE: Record<SubgraphEdgeKind, { stroke: string; dash: string; label: string }> = {
  CALLS: { stroke: '#2af0d6', dash: '', label: 'calls' },
  IMPORTS: { stroke: '#5ac8ff', dash: '4 3', label: 'imports' },
  EXTENDS: { stroke: '#d9a657', dash: '', label: 'extends' },
  IMPLEMENTS: { stroke: '#d9a657', dash: '4 3', label: 'implements' },
  REFERENCES: { stroke: '#5a6a8a', dash: '2 4', label: 'references' },
}
