/**
 * Code-view empty-state visualization: a layered module-DAG of the repo's AST
 * symbol graph. Deliberately NOT the memory GraphView's D3 force simulation —
 * deterministic left→right dependency tiers, per-file containers, and typed
 * edges (CALLS/IMPORTS/EXTENDS/IMPLEMENTS/REFERENCES) distinguished by color +
 * dash. Clicking a symbol node selects it via `onSelect`, handing off to the
 * Code-view inspector.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import { graphSymbolSubgraph, type SymbolSubgraph } from '@/adapters/graph'
import { layoutCodeGraph, EDGE_STYLE, type LayoutResult } from './codeGraphLayout'

const TOP_N_DEFAULT = 60
const SYMBOL_TONE = '#b070ff' // matches the symbol inspector accent

export function CodeGraphView({
  repo,
  branch,
  machine,
  onSelect,
  onBranchResolved,
}: {
  repo: string | null
  branch?: string
  machine?: string
  onSelect: (id: string) => void
  /** Reports the branch the server actually resolved/displayed (for the bar). */
  onBranchResolved?: (branch: string) => void
}) {
  const [data, setData] = useState<SymbolSubgraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'symbols' | 'all'>('symbols')
  const svgRef = useRef<SVGSVGElement>(null)
  const gRef = useRef<SVGGElement>(null)
  const roRef = useRef<ResizeObserver | null>(null)
  const [dims, setDims] = useState({ width: 0, height: 0 })

  // Callback ref so measurement attaches WHEN the container actually mounts.
  // The container only renders after the async fetch resolves (the no-repo /
  // loading / empty states return early, before this div exists). A plain
  // useEffect([]) ran once on mount — while the loading branch was showing, so
  // the ResizeObserver never attached, dims stayed 0, `layout` (gated on
  // dims.width) stayed null, and only the legend rendered. A callback ref fires
  // on each real (re)mount, so the observer attaches and dims get measured.
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    const measure = (w: number, h: number) => {
      if (w > 0 && h > 0) setDims({ width: w, height: h })
    }
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) measure(r.width, r.height)
    })
    ro.observe(el)
    roRef.current = ro
    const b = el.getBoundingClientRect()
    measure(b.width, b.height)
  }, [])

  useEffect(() => {
    if (!repo) {
      setData(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    graphSymbolSubgraph({ repo, branch, machine, topN: TOP_N_DEFAULT, mode })
      .then((g) => {
        if (!cancelled) {
          setData(g)
          setLoading(false)
          if (g.branch) onBranchResolved?.(g.branch)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [repo, branch, machine, mode])

  const layout: LayoutResult | null = useMemo(() => {
    if (!data || data.nodes.length === 0 || dims.width === 0) return null
    // Declutter: drop module nodes with no incident edge — isolated file boxes
    // are pure noise (a file with no top-N symbol and no edges to/from the kept
    // set). Symbols are always kept; edges are unchanged.
    const linked = new Set<string>()
    for (const e of data.edges) {
      linked.add(e.from)
      linked.add(e.to)
    }
    const nodes = data.nodes.filter((n) => n.type === 'symbol' || linked.has(n.id))
    return layoutCodeGraph({ nodes, edges: data.edges }, { width: dims.width, height: dims.height })
  }, [data, dims])

  // Pan/zoom (d3-zoom on the <g>) — view manipulation only, no simulation.
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return
    const svg = d3.select(svgRef.current)
    const g = d3.select(gRef.current)
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 3])
      .on('zoom', (ev) => g.attr('transform', ev.transform))
    svg.call(zoom)
    return () => {
      svg.on('.zoom', null)
    }
  }, [layout])

  if (!repo) {
    return (
      <div className="h-full flex items-center justify-center t-dim text-[12px]">
        Pick a repo to see its code graph, or select a symbol to inspect it.
      </div>
    )
  }
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center t-dim text-[12px]">
        <span className="caret">building code graph</span>
      </div>
    )
  }
  if (!data || data.nodes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center t-dim text-[12px]">
        No symbol graph for {repo} on {data?.branch || branch || 'this branch'}.
      </div>
    )
  }

  return (
    <div
      ref={setContainerRef}
      className="h-full w-full relative overflow-hidden grid-dot"
      style={{ background: 'radial-gradient(ellipse at 30% 20%, #120a22 0%, #0a0716 70%)' }}
    >
      <svg ref={svgRef} width={dims.width} height={dims.height} style={{ display: 'block' }}>
        <g ref={gRef}>
          {/* Containers */}
          {layout?.containers.map((c) => (
            <g key={c.file}>
              <rect
                x={c.x}
                y={c.y}
                width={c.w}
                height={c.h}
                rx={10}
                fill="rgba(176,112,255,0.04)"
                stroke="rgba(176,112,255,0.25)"
                strokeWidth={1}
              />
              <text
                x={c.x + 8}
                y={c.y + 14}
                fontFamily="JetBrains Mono, monospace"
                fontSize="9"
                fill="rgba(176,112,255,0.7)"
              >
                {c.file}
              </text>
            </g>
          ))}
          {/* Edges */}
          {layout?.edges.map((e, i) => {
            const st = EDGE_STYLE[e.kind]
            const mx = (e.x1 + e.x2) / 2
            return (
              <path
                key={i}
                d={`M${e.x1},${e.y1} C${mx},${e.y1} ${mx},${e.y2} ${e.x2},${e.y2}`}
                fill="none"
                stroke={st.stroke}
                strokeOpacity={0.32}
                strokeWidth={e.weight ? Math.min(3, 1 + Math.log2(e.weight)) : 1}
                strokeDasharray={st.dash || undefined}
              />
            )
          })}
          {/* Nodes */}
          {layout?.nodes.map((n) => {
            const isSymbol = n.type === 'symbol'
            const stale = isSymbol && !n.groundTruthValid
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                cursor={isSymbol ? 'pointer' : 'default'}
                onClick={() => {
                  if (isSymbol) onSelect(n.id)
                }}
              >
                {isSymbol ? (
                  <circle
                    r={n.r}
                    fill={SYMBOL_TONE}
                    fillOpacity={0.18}
                    stroke={stale ? '#ff6b6b' : SYMBOL_TONE}
                    strokeWidth={1.4}
                  />
                ) : (
                  <rect
                    x={-n.r}
                    y={-n.r}
                    width={n.r * 2}
                    height={n.r * 2}
                    rx={4}
                    fill="rgba(90,106,138,0.12)"
                    stroke="rgba(90,106,138,0.6)"
                    strokeWidth={1}
                  />
                )}
                <text
                  x={0}
                  y={n.r + 11}
                  textAnchor="middle"
                  fontFamily="JetBrains Mono, monospace"
                  fontSize="9"
                  fill={isSymbol ? SYMBOL_TONE : 'var(--color-dim)'}
                  fillOpacity={0.9}
                  pointerEvents="none"
                >
                  {n.label.length > 20 ? n.label.slice(0, 18) + '…' : n.label}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      {/* Legend */}
      <div className="absolute top-3 left-3 flex flex-col gap-1 text-[10px] bg-black/40 px-2.5 py-2 rounded">
        {(Object.keys(EDGE_STYLE) as (keyof typeof EDGE_STYLE)[]).map((k) => (
          <div key={k} className="flex items-center gap-1.5">
            <svg width="20" height="6">
              <line
                x1="0"
                y1="3"
                x2="20"
                y2="3"
                stroke={EDGE_STYLE[k].stroke}
                strokeWidth="1.5"
                strokeDasharray={EDGE_STYLE[k].dash || undefined}
              />
            </svg>
            <span className="t-dim">{EDGE_STYLE[k].label}</span>
          </div>
        ))}
      </div>

      {/* Controls + truncation note */}
      <div className="absolute bottom-3 right-3 flex items-center gap-2 t-ghost text-[10px]">
        {data.truncated && mode === 'symbols' && (
          <span
            title={`Showing top ${TOP_N_DEFAULT} of ${data.totalSymbols} by centrality; the rest fold into file modules`}
          >
            top {TOP_N_DEFAULT} of {data.totalSymbols}
          </span>
        )}
        <button
          className="btn text-[10px]"
          onClick={() => setMode((m) => (m === 'symbols' ? 'all' : 'symbols'))}
          title="Toggle between top-N+modules and every symbol"
        >
          {mode === 'symbols' ? 'show all' : 'show top'}
        </button>
        <span>scroll to zoom · drag to pan · click a symbol to inspect</span>
      </div>
    </div>
  )
}
