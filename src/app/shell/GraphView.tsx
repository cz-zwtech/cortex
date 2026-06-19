/**
 * Cortex Graph view — controls sidebar + SVG canvas + side drawer.
 *
 * The drawer is overlaid on the canvas (not a separate panel) and is
 * inspection-only: clicking a node never cross-filters Knowledge or Config.
 */
import { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import * as d3 from 'd3'
import { useStore } from '@/app/store'
import { graphSymbolGraph, type GraphLink, type GraphNode, type GraphEdge } from '@/adapters/graph'
import { nodeHighlight, textOpacity, edgeHighlight, setsEqual } from './graphHighlight'
import { relColor, relVisible } from './graphEdgeStyle'

// Tone for cluster colors — phos / amber / rose / cyan / dim per spec.
const KIND_TONE: Record<string, string> = {
  memory: '#2af0d6',
  feedback: '#d9a657',
  reference: '#5ac8ff',
  concept: '#2af0d6',
  technology: '#5ac8ff',
  pattern: '#b070ff',
  decision: '#ff6ec7',
  project: '#ff6ec7',
  // Code-graph symbols — violet, matching the symbol inspector accent. Graph
  // nodes cluster under the single 'symbol' kind (one legend toggle); the detail
  // drawer uses the real symbolKind (module/function/…), so map those to the
  // same violet family for a consistent tone.
  symbol: '#b070ff',
  module: '#b070ff',
  function: '#b070ff',
  class: '#b070ff',
  method: '#b070ff',
  interface: '#b070ff',
  variable: '#b070ff',
  type: '#b070ff',
}
const toneFor = (kind: string) => KIND_TONE[kind] ?? '#5a6a8a'

// ── D3 simulation types ──────────────────────────────────────────────────────

interface SimNode extends d3.SimulationNodeDatum {
  id: string
  name: string
  kind: string
  scope: string
}

interface SimEdge extends d3.SimulationLinkDatum<SimNode> {
  rel?: string
  label: string
}

// ── Graph canvas ─────────────────────────────────────────────────────────────

type Layout = 'force' | 'radial' | 'temporal'

function GraphCanvas({
  nodes,
  edges,
  activeId,
  highlightedKinds,
  highlightedRels,
  layout,
  onNodeClick,
}: {
  nodes: (SimNode & { syncedAt?: number; updatedAt?: number })[]
  edges: { from: string; to: string; rel?: string; label?: string }[]
  activeId: string | null
  highlightedKinds: Set<string>
  highlightedRels: Set<string>
  layout: Layout
  onNodeClick: (id: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [dims, setDims] = useState({ width: 0, height: 0 })

  // #122(b): hold onNodeClick in a ref so buildGraph does NOT depend on its identity
  // — a fresh inline arrow from the parent each render must not tear down + cold-
  // restart the whole force simulation. The click handler reads the latest via the ref.
  const onNodeClickRef = useRef(onNodeClick)
  onNodeClickRef.current = onNodeClick
  // #122(c): retained d3 selections so the highlight effect restyles in place (scoped
  // to the affected elements) instead of re-querying the whole SVG with svg.selectAll.
  const nodeSelRef = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null)
  const linkSelRef = useRef<d3.Selection<SVGLineElement, SimEdge, SVGGElement, unknown> | null>(null)
  const prevActiveRef = useRef<string | null>(null)
  const prevKindsRef = useRef<Set<string>>(new Set())
  const prevRelsRef = useRef<Set<string>>(new Set())
  const needsFullRestyleRef = useRef(true)

  // Measure
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const e = entries[0]
      if (!e) return
      const { width, height } = e.contentRect
      if (width > 0 && height > 0) setDims({ width, height })
    })
    ro.observe(el)
    const { width, height } = el.getBoundingClientRect()
    if (width > 0 && height > 0) setDims({ width, height })
    return () => ro.disconnect()
  }, [nodes.length])

  const buildGraph = useCallback(() => {
    const { width, height } = dims
    if (!svgRef.current || width === 0 || height === 0 || nodes.length === 0) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const simNodes: SimNode[] = nodes.map((n) => ({ ...n }))
    const nodeById = new Map(simNodes.map((n) => [n.id, n]))

    const simEdges: SimEdge[] = edges
      .map((e) => ({
        source: nodeById.get(e.from)!,
        target: nodeById.get(e.to)!,
        rel: e.rel,
        label: e.label ?? '',
      }))
      .filter((e) => e.source && e.target)

    const g = svg.append('g')
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => g.attr('transform', event.transform))
    svg.call(zoom)
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2))

    // Edges
    const link = g
      .append('g')
      .selectAll<SVGLineElement, SimEdge>('line')
      .data(simEdges)
      .join('line')
      .attr('stroke', (d) => relColor(d.rel ?? ''))
      .attr('stroke-width', 1)
      .attr('stroke-opacity', 0.55)

    // Nodes
    const node = g
      .append('g')
      .selectAll<SVGGElement, SimNode>('g')
      .data(simNodes)
      .join('g')
      .attr('cursor', 'pointer')
      .on('click', (_event, d) => onNodeClickRef.current(d.id))

    node
      .append('circle')
      .attr('r', 7)
      .attr('fill', (d) => toneFor(d.kind))
      .attr('fill-opacity', 0.18)
      .attr('stroke', (d) => toneFor(d.kind))
      .attr('stroke-width', 1.4)

    if (simNodes.length <= 120) {
      node
        .append('text')
        .text((d) => (d.name.length > 22 ? d.name.slice(0, 20) + '…' : d.name))
        .attr('x', 0)
        .attr('y', 18)
        .attr('text-anchor', 'middle')
        .attr('font-family', 'JetBrains Mono, monospace')
        .attr('font-size', '10px')
        .attr('fill', (d) => toneFor(d.kind))
        .attr('fill-opacity', 0.95)
        .attr('pointer-events', 'none')
    }

    // Drag
    node.call(
      d3
        .drag<SVGGElement, SimNode>()
        .on('start', (event, d) => {
          if (!event.active) sim.alphaTarget(0.3).restart()
          d.fx = d.x
          d.fy = d.y
        })
        .on('drag', (event, d) => {
          d.fx = event.x
          d.fy = event.y
        })
        .on('end', (event, d) => {
          if (!event.active) sim.alphaTarget(0)
          d.fx = null
          d.fy = null
        }),
    )

    // Pick a force configuration based on the requested layout.
    // Force: free-floating with link/charge/collision.
    // Radial: nodes arranged on concentric circles by kind.
    // Temporal: nodes arranged left-to-right by syncedAt.
    let sim: d3.Simulation<SimNode, SimEdge>
    if (layout === 'radial') {
      const kinds = Array.from(new Set(simNodes.map((n) => n.kind)))
      const ringRadius = (kind: string) => {
        const i = kinds.indexOf(kind)
        return 80 + i * 70
      }
      sim = d3
        .forceSimulation(simNodes)
        .force(
          'link',
          d3
            .forceLink<SimNode, SimEdge>(simEdges)
            .id((d) => d.id)
            .distance(60)
            .strength(0.1),
        )
        .force('charge', d3.forceManyBody().strength(-60))
        .force('radial', d3.forceRadial<SimNode>((d) => ringRadius(d.kind), 0, 0).strength(0.9))
        .force('collision', d3.forceCollide(14))
    } else if (layout === 'temporal') {
      const tOf = (n: SimNode) => {
        const ext = n as SimNode & { syncedAt?: number; updatedAt?: number }
        return ext.syncedAt ?? ext.updatedAt ?? 0
      }
      const times = simNodes.map(tOf).filter((t) => t > 0)
      const tMin = times.length ? Math.min(...times) : 0
      const tMax = times.length ? Math.max(...times) : 1
      const xFor = (n: SimNode) => {
        const t = tOf(n) || tMin
        const span = Math.max(1, tMax - tMin)
        return ((t - tMin) / span) * (width * 0.8) - width * 0.4
      }
      sim = d3
        .forceSimulation(simNodes)
        .force(
          'link',
          d3
            .forceLink<SimNode, SimEdge>(simEdges)
            .id((d) => d.id)
            .distance(50)
            .strength(0.15),
        )
        .force('charge', d3.forceManyBody().strength(-50))
        .force('x', d3.forceX<SimNode>((d) => xFor(d)).strength(0.9))
        .force('y', d3.forceY<SimNode>(0).strength(0.04))
        .force('collision', d3.forceCollide(14))
    } else {
      // Original force-directed configuration — restored after a few attempts
      // to "fix" loners pushed it in worse directions. Good enough as a base.
      sim = d3
        .forceSimulation(simNodes)
        .force(
          'link',
          d3
            .forceLink<SimNode, SimEdge>(simEdges)
            .id((d) => d.id)
            .distance(80)
            .strength(0.4),
        )
        .force('charge', d3.forceManyBody().strength(-120))
        .force('center', d3.forceCenter(0, 0))
        .force('collision', d3.forceCollide(14))
    }

    sim.on('tick', () => {
      link
        .attr('x1', (d) => (d.source as SimNode).x ?? 0)
        .attr('y1', (d) => (d.source as SimNode).y ?? 0)
        .attr('x2', (d) => (d.target as SimNode).x ?? 0)
        .attr('y2', (d) => (d.target as SimNode).y ?? 0)
      node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    // Retain the selections for the highlight effect + force its next pass to be a
    // FULL restyle (the DOM was just rebuilt).
    nodeSelRef.current = node
    linkSelRef.current = link
    needsFullRestyleRef.current = true

    return () => {
      sim.stop()
    }
  }, [nodes, edges, dims, layout])

  useEffect(() => {
    const cleanup = buildGraph()
    return cleanup
  }, [buildGraph])

  // Highlight selected node + its edges; cluster filter dims non-matching nodes.
  // Restyles the RETAINED selections in place — scoped to the affected elements on a
  // selection-only change — instead of re-querying the whole SVG with svg.selectAll
  // and restyling every element on every selection/filter change.
  useEffect(() => {
    const nodeSel = nodeSelRef.current
    const linkSel = linkSelRef.current
    if (!nodeSel || !linkSel) return

    const activeNode = nodes.find((n) => n.id === activeId)
    const activeTone = activeNode ? toneFor(activeNode.kind) : null

    const styleNodes = (sel: d3.Selection<SVGGElement, SimNode, SVGGElement, unknown>) => {
      sel
        .select<SVGCircleElement>('circle')
        .attr('stroke-width', (d) => nodeHighlight(d.id, d.kind, activeId, highlightedKinds).strokeWidth)
        .attr('fill-opacity', (d) => nodeHighlight(d.id, d.kind, activeId, highlightedKinds).fillOpacity)
        .attr('r', (d) => nodeHighlight(d.id, d.kind, activeId, highlightedKinds).r)
        .style('opacity', (d) => nodeHighlight(d.id, d.kind, activeId, highlightedKinds).opacity)
        .style('filter', (d) =>
          d.id === activeId ? `drop-shadow(0 0 14px ${toneFor(d.kind)})` : 'none',
        )
      sel.select<SVGTextElement>('text').style('opacity', (d) => textOpacity(d.kind, highlightedKinds))
    }

    const styleEdges = (sel: d3.Selection<SVGLineElement, SimEdge, SVGGElement, unknown>) => {
      const hl = (d: SimEdge) =>
        edgeHighlight(
          (d.source as SimNode).id,
          (d.target as SimNode).id,
          (d.source as SimNode).kind,
          (d.target as SimNode).kind,
          activeId,
          highlightedKinds,
        )
      sel
        .attr('stroke', (d) => (hl(d).touchesActive && activeTone ? activeTone : relColor(d.rel ?? '')))
        // The per-rel filter hides only edges that HAVE a rel and are filtered out;
        // overlay edges without a rel stay governed by the showCode toggle, never the
        // rel filter. Default (empty filter) shows everything — Corey's intent.
        .attr('stroke-opacity', (d) =>
          d.rel !== undefined && !relVisible(d.rel, highlightedRels) ? 0 : hl(d).strokeOpacity,
        )
        .attr('stroke-width', (d) => hl(d).strokeWidth)
    }

    // A cluster-filter change affects every element → full restyle. A selection-only
    // change touches just the previously- and newly-active node + their incident edges.
    const full =
      needsFullRestyleRef.current ||
      !setsEqual(prevKindsRef.current, highlightedKinds) ||
      !setsEqual(prevRelsRef.current, highlightedRels)
    if (full) {
      styleNodes(nodeSel)
      styleEdges(linkSel)
    } else {
      const prevActive = prevActiveRef.current
      const touched = (id: string | null) => id === activeId || id === prevActive
      styleNodes(nodeSel.filter((d) => touched(d.id)))
      styleEdges(linkSel.filter((d) => touched((d.source as SimNode).id) || touched((d.target as SimNode).id)))
    }

    prevActiveRef.current = activeId ?? null
    prevKindsRef.current = new Set(highlightedKinds)
    prevRelsRef.current = new Set(highlightedRels)
    needsFullRestyleRef.current = false
    // Include every buildGraph rebuild trigger (nodes/edges/dims/layout), not just
    // the selection/filter inputs: a rebuild from a resize or layout toggle installs
    // fresh selections + needsFullRestyle, so the highlight effect MUST re-run to
    // re-apply the active/filter styling onto the new DOM (else it's lost until the
    // next selection change).
  }, [activeId, nodes, edges, dims, layout, highlightedKinds, highlightedRels])

  return (
    <div
      ref={containerRef}
      className="flex-1 min-w-0 relative overflow-hidden grid-dot"
      style={{
        background:
          'radial-gradient(ellipse at center, #0a0c22 0%, #07081a 60%, #05061a 100%)',
      }}
    >
      <svg ref={svgRef} width={dims.width} height={dims.height} style={{ display: 'block' }} />
      <div className="absolute bottom-3 right-3 t-ghost text-[10px]">
        scroll to zoom · drag to pan · click node to inspect
      </div>
    </div>
  )
}

// ── Controls sidebar ─────────────────────────────────────────────────────────

function GraphControls({
  clusterCounts,
  highlightedKinds,
  onToggleKind,
  relCounts,
  highlightedRels,
  onToggleRel,
  layout,
  onSetLayout,
  totalNodes,
  totalEdges,
  onSync,
  showCode,
  onToggleCode,
  codeLoading,
}: {
  clusterCounts: { kind: string; count: number }[]
  highlightedKinds: Set<string>
  onToggleKind: (kind: string) => void
  relCounts: { rel: string; count: number }[]
  highlightedRels: Set<string>
  onToggleRel: (rel: string) => void
  layout: Layout
  onSetLayout: (l: Layout) => void
  totalNodes: number
  totalEdges: number
  onSync: () => void
  showCode: boolean
  onToggleCode: () => void
  codeLoading: boolean
}) {
  const layouts: { k: Layout; label: string }[] = [
    { k: 'force', label: 'force-directed' },
    { k: 'radial', label: 'radial' },
    { k: 'temporal', label: 'temporal' },
  ]
  const hasFilter = highlightedKinds.size > 0
  const hasRelFilter = highlightedRels.size > 0
  return (
    <aside
      className="shrink-0 border-r border-[var(--color-line)] flex flex-col"
      style={{ width: 'var(--pane-narrow)', background: 'var(--color-bg-1)' }}
    >
      <div className="px-3.5 pt-2.5 pb-2 border-b border-[var(--color-line)] flex items-center gap-1.5">
        <span className="t-ghost text-[10px] tracking-[0.25em] flex-1">// CLUSTERS</span>
        <button onClick={onSync} className="btn text-[10px]" title="Sync memory files">
          ↻
        </button>
      </div>

      <div className="px-3.5 py-2.5">
        {clusterCounts.map(({ kind, count }) => {
          const on = highlightedKinds.has(kind)
          // When no filter is active, every cluster is "in" — so the bullet shows full color.
          // When a filter IS active, non-matching kinds dim.
          const dimmed = hasFilter && !on
          return (
            <button
              key={kind}
              onClick={() => onToggleKind(kind)}
              className="w-full flex items-center justify-between text-[11px] py-1 transition-colors hover:text-[color:var(--color-pale)]"
              style={{
                color: dimmed ? 'var(--color-dim)' : 'var(--color-mid)',
                opacity: dimmed ? 0.55 : 1,
              }}
              title={on ? `Clear ${kind} filter` : `Highlight ${kind} nodes`}
            >
              <span>
                <span style={{ color: dimmed ? 'var(--color-ghost)' : toneFor(kind), marginRight: 6 }}>●</span>
                {kind}
              </span>
              <span className="t-ghost text-[9px]">· {count}</span>
            </button>
          )
        })}
        {clusterCounts.length === 0 && (
          <div className="t-dim text-[11px] italic">No clusters.</div>
        )}
        {hasFilter && (
          <button
            onClick={() => highlightedKinds.forEach(onToggleKind)}
            className="t-ghost text-[10px] hover:text-[color:var(--color-mid)] mt-1.5"
          >
            clear filter
          </button>
        )}
      </div>

      <div className="border-t border-[var(--color-line)] px-3.5 py-2.5">
        <span className="t-ghost text-[10px] tracking-[0.25em]">// RELATIONS</span>
        <div className="mt-1.5">
          {relCounts.map(({ rel, count }) => {
            const on = highlightedRels.has(rel)
            const dimmed = hasRelFilter && !on
            return (
              <button
                key={rel}
                onClick={() => onToggleRel(rel)}
                className="w-full flex items-center justify-between text-[11px] py-1 transition-colors hover:text-[color:var(--color-pale)]"
                style={{
                  color: dimmed ? 'var(--color-dim)' : 'var(--color-mid)',
                  opacity: dimmed ? 0.55 : 1,
                }}
                title={on ? `Clear ${rel} filter` : `Show only ${rel} edges`}
              >
                <span>
                  <span style={{ color: dimmed ? 'var(--color-ghost)' : relColor(rel), marginRight: 6 }}>―</span>
                  {rel}
                </span>
                <span className="t-ghost text-[9px]">· {count}</span>
              </button>
            )
          })}
          {relCounts.length === 0 && <div className="t-dim text-[11px] italic">No edges.</div>}
          {hasRelFilter && (
            <button
              onClick={() => highlightedRels.forEach(onToggleRel)}
              className="t-ghost text-[10px] hover:text-[color:var(--color-mid)] mt-1.5"
            >
              clear filter
            </button>
          )}
        </div>
      </div>

      <div className="border-t border-[var(--color-line)] px-3.5 py-2.5">
        <span className="t-ghost text-[10px] tracking-[0.25em]">// LAYOUT</span>
        <div className="mt-1.5 flex flex-col">
          {layouts.map(({ k, label }) => {
            const on = layout === k
            return (
              <button
                key={k}
                onClick={() => onSetLayout(k)}
                className="text-[11px] text-left py-0.5 transition-colors hover:text-[color:var(--color-pale)]"
                style={{ color: on ? 'var(--color-mid)' : 'var(--color-dim)' }}
              >
                {on ? '◉' : '○'} {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="border-t border-[var(--color-line)] px-3.5 py-2.5">
        <span className="t-ghost text-[10px] tracking-[0.25em]">// OVERLAY</span>
        <div className="mt-1.5">
          <button
            onClick={onToggleCode}
            disabled={codeLoading}
            className="text-[11px] text-left py-0.5 transition-colors hover:text-[color:var(--color-pale)] disabled:opacity-50"
            style={{ color: showCode ? 'var(--color-mid)' : 'var(--color-dim)' }}
            title="Fold the code/AST symbol graph into the mind graph"
          >
            <span style={{ color: showCode ? toneFor('symbol') : 'var(--color-ghost)', marginRight: 6 }}>●</span>
            {showCode ? '◉' : '○'} show code graph
            {codeLoading && <span className="t-ghost ml-1">…</span>}
          </button>
        </div>
      </div>

      <div className="border-t border-[var(--color-line)] px-3.5 py-2.5">
        <span className="t-ghost text-[10px] tracking-[0.25em]">// HINT</span>
        <div className="t-dim text-[10px] mt-1.5 leading-[1.6]">
          Click a node to inspect — info opens in a side panel; the rest of the graph is unaffected.
          Click a cluster to highlight nodes of that kind.
        </div>
      </div>

      <div className="flex-1" />

      <div className="border-t border-[var(--color-line)] px-3.5 py-2 t-ghost text-[10px] font-mono">
        {totalNodes} nodes · {totalEdges} edges
      </div>
    </aside>
  )
}

// ── Side drawer ──────────────────────────────────────────────────────────────

function NodeDrawer({ onJumpTo }: { onJumpTo: (id: string) => void }) {
  const entry = useStore((s) => s.selectedEntry)
  const loading = useStore((s) => s.graphEntryLoading)
  const setSelected = useStore((s) => s.setSelectedEntryId)
  const setView = useStore((s) => s.setView)
  const setCodeFocus = useStore((s) => s.setCodeFocus)

  if (!entry && !loading) return null
  // Code-graph nodes carry a `repo:` scope — they belong to the Code view's
  // inspector (full signature + blast radius), not Knowledge.
  const isSymbol = !!entry?.scope?.startsWith('repo:')

  const tone = entry ? toneFor(entry.kind) : 'var(--color-phos)'

  return (
    <aside
      className="absolute top-0 right-0 bottom-0 flex flex-col drawer-slide-in z-10"
      style={{
        width: 'var(--drawer-w)',
        background: 'rgba(13,15,36,0.96)',
        borderLeft: `1px solid ${tone}`,
        boxShadow: `-8px 0 32px rgba(0,0,0,0.5), -2px 0 12px ${tone}33`,
      }}
    >
      {loading || !entry ? (
        <div className="flex-1 flex items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          {/* Header */}
          <div
            className="flex items-start gap-2.5"
            style={{ padding: '14px 16px', borderBottom: `1px solid ${tone}55` }}
          >
            <div className="flex-1 min-w-0">
              <div
                className="text-[9px] tracking-[0.2em] uppercase truncate"
                style={{ color: tone }}
              >
                {entry.kind} · {entry.id}
              </div>
              <div className="t-hi text-[14px] mt-1 leading-[1.3]">{entry.name}</div>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="btn t-ghost"
              style={{ fontSize: 18, lineHeight: 1, padding: 2 }}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {/* Quick stats */}
          <div
            className="grid grid-cols-3 gap-2.5"
            style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-line)' }}
          >
            <Stat label="EDGES" value={String(entry.links.length + entry.backlinks.length)} />
            <Stat label="OUT" value={String(entry.links.length)} />
            <Stat label="UPDATED" value={formatRelative(entry.updatedAt)} small />
          </div>

          {/* Description */}
          {entry.description && (
            <div
              style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-line)' }}
            >
              <div className="t-ghost text-[9px] tracking-[0.2em] mb-1.5">// DESCRIPTION</div>
              <div className="t-mid text-[11px] leading-[1.5]">{entry.description}</div>
            </div>
          )}

          {/* Body */}
          <div className="flex-1 overflow-auto" style={{ padding: '12px 16px' }}>
            <div className="t-ghost text-[9px] tracking-[0.2em] mb-1.5">// SUMMARY</div>
            <div className="t-mid text-[11px] leading-[1.65] whitespace-pre-wrap">
              {entry.content
                ? entry.content.length > 800
                  ? entry.content.slice(0, 800) + '…'
                  : entry.content
                : '(no summary content for this node.)'}
            </div>

            {entry.links.length + entry.backlinks.length > 0 && (
              <>
                <div className="t-ghost text-[9px] tracking-[0.2em] mt-4 mb-1.5">
                  // CONNECTED · {entry.links.length + entry.backlinks.length}
                </div>
                <div className="flex flex-col gap-1">
                  {[...entry.links, ...entry.backlinks].map((nb, i) => (
                    <NeighborRow
                      key={`${nb.id}-${i}`}
                      link={nb}
                      onClick={() => onJumpTo(nb.id)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div
            className="flex items-center gap-3 text-[11px]"
            style={{ padding: '10px 16px', borderTop: '1px solid var(--color-line)' }}
          >
            <button
              onClick={() => {
                if (isSymbol && entry) {
                  setCodeFocus(entry.id)
                  setView('code')
                } else {
                  setView('knowledge')
                }
              }}
              className="btn t-ghost"
            >
              {isSymbol ? 'open in code' : 'open in knowledge'}
            </button>
            <span className="flex-1" />
            <span className="btn t-ghost cursor-default opacity-60" title="Coming soon">⌕ isolate</span>
          </div>
        </>
      )}
    </aside>
  )
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div>
      <div className="t-ghost text-[9px] tracking-[0.15em]">{label}</div>
      <div className="t-hi mt-0.5 tabular-nums" style={{ fontSize: small ? 11 : 14 }}>
        {value}
      </div>
    </div>
  )
}

function NeighborRow({ link, onClick }: { link: GraphLink; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 w-full text-left hover:bg-[rgba(255,255,255,0.03)] transition-colors"
      style={{
        padding: '6px 8px',
        border: '1px solid var(--color-line)',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <span style={{ color: toneFor(link.kind), fontSize: 12 }}>●</span>
      <span className="t-mid text-[11px] flex-1 min-w-0 truncate">{link.name}</span>
      <span className="t-ghost text-[9px]">→</span>
    </button>
  )
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      style={{ color: 'var(--color-dim)' }}
    >
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
    </svg>
  )
}

function formatRelative(ts: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  const hrs = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hrs < 24) return `${hrs}h ago`
  return `${days}d ago`
}

// ── Main view ────────────────────────────────────────────────────────────────

export function GraphView() {
  const nodes = useStore((s) => s.graphAllNodes)
  const edges = useStore((s) => s.graphAllEdges)
  const loading = useStore((s) => s.graphAllLoading)
  const selectedId = useStore((s) => s.selectedEntryId)
  const setSelected = useStore((s) => s.setSelectedEntryId)
  const triggerSync = useStore((s) => s.triggerGraphSync)

  const [highlightedKinds, setHighlightedKinds] = useState<Set<string>>(new Set())
  // #126: opt-in per-rel declutter filter. Default empty = ALL edge types shown
  // (Corey's intent: the graph represents everything, including islands).
  const [highlightedRels, setHighlightedRels] = useState<Set<string>>(new Set())
  const [layout, setLayout] = useState<Layout>('force')

  // Code-graph overlay — OFF by default. Symbol nodes/edges are fetched lazily
  // the first time the toggle is enabled, cached client-side, then merged into
  // the dataset. Toggling off restores the pure memory graph (no refetch).
  const [showCode, setShowCode] = useState(false)
  const [codeLoading, setCodeLoading] = useState(false)
  const [codeGraph, setCodeGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null)

  const toggleCode = useCallback(() => {
    if (showCode) {
      setShowCode(false)
      return
    }
    if (codeGraph) {
      setShowCode(true)
      return
    }
    setCodeLoading(true)
    graphSymbolGraph()
      .then((g) => {
        setCodeGraph(g)
        setShowCode(true)
      })
      .catch(() => {})
      .finally(() => setCodeLoading(false))
  }, [showCode, codeGraph])

  // Merge memory graph with the code overlay when enabled. Symbol ids
  // (repo:file#name) never collide with memory ids, so a plain concat is safe.
  const mergedNodes = useMemo(
    () => (showCode && codeGraph ? [...nodes, ...codeGraph.nodes] : nodes),
    [showCode, codeGraph, nodes],
  )
  const mergedEdges = useMemo(
    () => (showCode && codeGraph ? [...edges, ...codeGraph.edges] : edges),
    [showCode, codeGraph, edges],
  )

  const toggleKind = (kind: string) =>
    setHighlightedKinds((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })

  const toggleRel = (rel: string) =>
    setHighlightedRels((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })

  // Cluster counts: distinct kinds with counts (over the merged dataset so the
  // 'symbol' cluster shows up when the overlay is on).
  const clusterCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const n of mergedNodes) map.set(n.kind, (map.get(n.kind) ?? 0) + 1)
    return Array.from(map.entries())
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count)
  }, [mergedNodes])

  // Relation counts over the merged dataset — drives the // RELATIONS filter. Edges
  // without a rel (symbol-overlay edges) are not rel-filterable and are skipped here.
  const relCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of mergedEdges) {
      const rel = (e as { rel?: string }).rel
      if (!rel) continue
      map.set(rel, (map.get(rel) ?? 0) + 1)
    }
    return Array.from(map.entries())
      .map(([rel, count]) => ({ rel, count }))
      .sort((a, b) => b.count - a.count)
  }, [mergedEdges])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center t-dim text-[12px]">
        <span className="caret">loading graph</span>
      </div>
    )
  }

  if (nodes.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <div className="t-dim text-[12px]">No nodes in graph.</div>
        <button onClick={() => void triggerSync()} className="btn text-[11px]">
          ↻ Sync memory files
        </button>
      </div>
    )
  }

  return (
    <>
      <GraphControls
        clusterCounts={clusterCounts}
        highlightedKinds={highlightedKinds}
        onToggleKind={toggleKind}
        relCounts={relCounts}
        highlightedRels={highlightedRels}
        onToggleRel={toggleRel}
        layout={layout}
        onSetLayout={setLayout}
        totalNodes={mergedNodes.length}
        totalEdges={mergedEdges.length}
        onSync={() => void triggerSync()}
        showCode={showCode}
        onToggleCode={toggleCode}
        codeLoading={codeLoading}
      />
      <div className="flex-1 min-w-0 relative flex">
        <GraphCanvas
          nodes={mergedNodes as (SimNode & { syncedAt?: number; updatedAt?: number })[]}
          edges={mergedEdges}
          activeId={selectedId}
          highlightedKinds={highlightedKinds}
          highlightedRels={highlightedRels}
          layout={layout}
          onNodeClick={(id) => setSelected(id === selectedId ? null : id)}
        />
        {selectedId && <NodeDrawer onJumpTo={(id) => setSelected(id)} />}
      </div>
    </>
  )
}
