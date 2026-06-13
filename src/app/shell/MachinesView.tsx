/**
 * Cortex Machines view — living mesh health topology.
 *
 * Hub-and-spoke D3 force graph: one central "private-mind" hub node,
 * one rounded-rect node per living machine (retired nodes excluded by the API),
 * a federation edge (dashed) from hub→every living machine. Plus live bus edges
 * (solid) between any two distinct machines that are both `live`.
 *
 * Dormant machines are dimmed. Clicking a machine opens a right-hand inspector.
 */
import { useRef, useEffect, useCallback, useState } from 'react'
import * as d3 from 'd3'
import { useStore } from '@/app/store'
import { graphListMachines, type MachineInfo } from '@/adapters/graph'

// ── Palette ──────────────────────────────────────────────────────────────────

const COLOR_HUB = '#2af0d6'       // phos — hub node
const COLOR_SELF = '#b070ff'      // violet — this machine
const COLOR_PEER = '#5ac8ff'      // cyan — peer machine
const COLOR_ACTIVE = '#d9a657'    // amber — machine has live sessions
const COLOR_EDGE = '#2a3158'      // dim line — git-sync federation
const COLOR_BUS = '#2af0d6'       // phos — live cross-machine bus link

// ── D3 simulation types ───────────────────────────────────────────────────────

interface MachineSimNode extends d3.SimulationNodeDatum {
  id: string
  label: string
  kind: 'hub' | 'machine'
  isSelf: boolean
  isActive: boolean
  info: MachineInfo | null
}

type EdgeKind = 'federation' | 'bus'

interface MachineSimEdge extends d3.SimulationLinkDatum<MachineSimNode> {
  // 'federation' = hub↔machine git-sync; 'bus' = live machine↔machine bus link
  edgeKind: EdgeKind
}

interface MachineEdge {
  from: string
  to: string
  edgeKind: EdgeKind
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelative(ms: number): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  const mins = Math.floor(diff / 60_000)
  const hrs = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hrs < 24) return `${hrs}h ago`
  return `${days}d ago`
}

function nodeColor(n: MachineSimNode): string {
  if (n.kind === 'hub') return COLOR_HUB
  if (n.isActive) return COLOR_ACTIVE
  if (n.isSelf) return COLOR_SELF
  return COLOR_PEER
}

function nodeOpacity(n: MachineSimNode): number {
  if (n.kind === 'hub') return 1
  if (n.info?.status === 'dormant') return 0.45
  return 1
}

// ── Graph canvas ──────────────────────────────────────────────────────────────

function MachineCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: MachineSimNode[]
  edges: MachineEdge[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [dims, setDims] = useState({ width: 0, height: 0 })

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

    const simNodes: MachineSimNode[] = nodes.map((n) => ({ ...n }))
    const nodeById = new Map(simNodes.map((n) => [n.id, n]))

    const simEdges: MachineSimEdge[] = edges
      .map((e) => ({
        source: nodeById.get(e.from)!,
        target: nodeById.get(e.to)!,
        edgeKind: e.edgeKind,
      }))
      .filter((e) => e.source && e.target)

    const g = svg.append('g')

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => g.attr('transform', event.transform))
    svg.call(zoom)
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2))

    // Edges — federation (dashed/dim) vs live bus link (solid/phos)
    const link = g
      .append('g')
      .selectAll<SVGLineElement, MachineSimEdge>('line')
      .data(simEdges)
      .join('line')
      .attr('stroke', (d) => (d.edgeKind === 'bus' ? COLOR_BUS : COLOR_EDGE))
      .attr('stroke-width', (d) => (d.edgeKind === 'bus' ? 1.8 : 1.2))
      .attr('stroke-opacity', (d) => (d.edgeKind === 'bus' ? 0.8 : 0.55))
      .attr('stroke-dasharray', (d) => (d.edgeKind === 'bus' ? 'none' : '4 3'))

    // Nodes: hub is a circle, machines are rounded rects
    const node = g
      .append('g')
      .selectAll<SVGGElement, MachineSimNode>('g')
      .data(simNodes)
      .join('g')
      .attr('cursor', (d) => (d.kind === 'machine' ? 'pointer' : 'default'))
      .on('click', (_event, d) => {
        if (d.kind === 'machine') onSelect(d.id)
      })

    // Hub — circle
    node
      .filter((d) => d.kind === 'hub')
      .append('circle')
      .attr('r', 18)
      .attr('fill', `${COLOR_HUB}18`)
      .attr('stroke', COLOR_HUB)
      .attr('stroke-width', 1.8)

    node
      .filter((d) => d.kind === 'hub')
      .append('text')
      .text('private-mind')
      .attr('x', 0)
      .attr('y', 32)
      .attr('text-anchor', 'middle')
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('font-size', '9px')
      .attr('fill', COLOR_HUB)
      .attr('fill-opacity', 0.85)
      .attr('pointer-events', 'none')

    // Machine — rounded rect
    const BOX_W = 100
    const BOX_H = 32

    node
      .filter((d) => d.kind === 'machine')
      .append('rect')
      .attr('x', -BOX_W / 2)
      .attr('y', -BOX_H / 2)
      .attr('width', BOX_W)
      .attr('height', BOX_H)
      .attr('rx', 6)
      .attr('ry', 6)
      .attr('fill', (d) => `${nodeColor(d)}14`)
      .attr('stroke', (d) => nodeColor(d))
      .attr('stroke-width', 1.4)
      .attr('opacity', (d) => nodeOpacity(d))

    // Hostname label inside box
    node
      .filter((d) => d.kind === 'machine')
      .append('text')
      .text((d) => (d.label.length > 14 ? d.label.slice(0, 12) + '…' : d.label))
      .attr('x', 0)
      .attr('y', 4)
      .attr('text-anchor', 'middle')
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('font-size', '11px')
      .attr('fill', (d) => nodeColor(d))
      .attr('fill-opacity', (d) => nodeOpacity(d) * 0.95)
      .attr('pointer-events', 'none')

    // Badges: "this machine" / "active"
    const machineNodes = node.filter((d) => d.kind === 'machine')

    machineNodes
      .filter((d) => d.isSelf)
      .append('text')
      .text('this machine')
      .attr('x', 0)
      .attr('y', -BOX_H / 2 - 6)
      .attr('text-anchor', 'middle')
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('font-size', '8px')
      .attr('fill', COLOR_SELF)
      .attr('fill-opacity', 0.9)
      .attr('pointer-events', 'none')

    machineNodes
      .filter((d) => !d.isSelf && d.isActive)
      .append('text')
      .text('active')
      .attr('x', BOX_W / 2 + 4)
      .attr('y', -4)
      .attr('text-anchor', 'start')
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('font-size', '8px')
      .attr('fill', COLOR_ACTIVE)
      .attr('fill-opacity', 0.9)
      .attr('pointer-events', 'none')

    // Active dot for self too (distinct from badge)
    machineNodes
      .filter((d) => d.isActive)
      .append('circle')
      .attr('cx', BOX_W / 2 - 4)
      .attr('cy', -BOX_H / 2 + 4)
      .attr('r', 3.5)
      .attr('fill', COLOR_ACTIVE)
      .attr('fill-opacity', 0.9)

    // Drag on machine nodes
    node.call(
      d3
        .drag<SVGGElement, MachineSimNode>()
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

    const sim = d3
      .forceSimulation(simNodes)
      .force(
        'link',
        d3
          .forceLink<MachineSimNode, MachineSimEdge>(simEdges)
          .id((d) => d.id)
          .distance(140)
          .strength(0.5),
      )
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter(0, 0))
      .force('collision', d3.forceCollide(60))

    sim.on('tick', () => {
      link
        .attr('x1', (d) => (d.source as MachineSimNode).x ?? 0)
        .attr('y1', (d) => (d.source as MachineSimNode).y ?? 0)
        .attr('x2', (d) => (d.target as MachineSimNode).x ?? 0)
        .attr('y2', (d) => (d.target as MachineSimNode).y ?? 0)
      node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    return () => {
      sim.stop()
    }
  }, [nodes, edges, dims, onSelect])

  useEffect(() => {
    const cleanup = buildGraph()
    return cleanup
  }, [buildGraph])

  // Highlight selected machine
  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    svg
      .selectAll<SVGRectElement, MachineSimNode>('rect')
      .attr('stroke-width', (d) => (d.id === selectedId ? 2.5 : 1.4))
      .attr('fill', (d) =>
        d.id === selectedId ? `${nodeColor(d)}28` : `${nodeColor(d)}14`,
      )
      .style('filter', (d) =>
        d.id === selectedId ? `drop-shadow(0 0 12px ${nodeColor(d)})` : 'none',
      )
  }, [selectedId])

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
        scroll to zoom · drag to pan · click machine to inspect
      </div>
    </div>
  )
}

// ── Inspector panel ───────────────────────────────────────────────────────────

function MachineInspector({
  machine,
  onClose,
}: {
  machine: MachineInfo
  onClose: () => void
}) {
  const tone = machine.status === 'live'
    ? COLOR_ACTIVE
    : machine.isSelf
      ? COLOR_SELF
      : COLOR_PEER

  return (
    <aside
      className="shrink-0 flex flex-col overflow-hidden"
      style={{
        width: 'var(--drawer-w, 300px)',
        background: 'rgba(13,15,36,0.97)',
        borderLeft: `1px solid ${tone}`,
        boxShadow: `-8px 0 32px rgba(0,0,0,0.5), -2px 0 12px ${tone}33`,
      }}
    >
      {/* Header */}
      <div
        className="flex items-start gap-2.5 shrink-0"
        style={{ padding: '14px 16px', borderBottom: `1px solid ${tone}55` }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-[9px] tracking-[0.2em] uppercase" style={{ color: tone }}>
            machine · {machine.machineId.slice(0, 12)}
          </div>
          <div className="t-hi text-[15px] mt-1 leading-[1.3] font-mono truncate">
            {machine.hostname}
          </div>
          <div className="flex gap-1.5 mt-1.5 flex-wrap">
            {machine.isSelf && (
              <span
                className="px-1.5 py-0.5 text-[9px] uppercase tracking-wide border"
                style={{ color: COLOR_SELF, borderColor: `${COLOR_SELF}66`, background: `${COLOR_SELF}12` }}
              >
                this machine
              </span>
            )}
            {machine.status === 'live' && machine.sessionCount > 0 && (
              <span
                className="px-1.5 py-0.5 text-[9px] uppercase tracking-wide border"
                style={{ color: COLOR_ACTIVE, borderColor: `${COLOR_ACTIVE}66`, background: `${COLOR_ACTIVE}12` }}
              >
                active · {machine.sessionCount} session{machine.sessionCount === 1 ? '' : 's'}
              </span>
            )}
            {machine.status === 'dormant' && (
              <span
                className="px-1.5 py-0.5 text-[9px] uppercase tracking-wide border"
                style={{ color: COLOR_PEER, borderColor: `${COLOR_PEER}44`, background: `${COLOR_PEER}0a`, opacity: 0.7 }}
              >
                dormant
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="btn t-ghost shrink-0"
          style={{ fontSize: 18, lineHeight: 1, padding: 2 }}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* Stats grid */}
      <div className="flex-1 overflow-auto" style={{ padding: '14px 16px' }}>
        <div className="t-ghost text-[9px] tracking-[0.2em] mb-3">// DETAILS</div>
        <dl className="flex flex-col gap-2.5">
          <Row label="Status" value={machine.status} />
          <Row label="Last contact" value={formatRelative(machine.lastContact)} />
          <Row label="Memory files" value={String(machine.memoryCount)} />
          <Row
            label="AST symbols"
            value={String(machine.symbolCount)}
            hint="origin = the machine that last upserted each symbol (newest-wins)"
          />
          <Row label="Sessions" value={String(machine.sessionCount)} />
        </dl>

        <div
          className="mt-5 text-[10px] leading-[1.7]"
          style={{ color: 'var(--color-dim)' }}
        >
          <span style={{ color: tone }}>●</span>{' '}
          Connected to the living mesh.
        </div>
      </div>
    </aside>
  )
}

function Row({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-line)] pb-1.5">
      <dt className="t-ghost text-[10px] shrink-0">{label}</dt>
      <dd className="t-mid text-[11px] font-mono text-right flex items-center gap-1.5">
        {value}
        {hint && (
          <span
            className="t-ghost text-[9px] font-sans cursor-help"
            title={hint}
            style={{ textDecoration: 'underline dotted', textUnderlineOffset: 2 }}
          >
            ?
          </span>
        )}
      </dd>
    </div>
  )
}

// ── Left sidebar ──────────────────────────────────────────────────────────────

function MachinesSidebar({
  total,
  liveLocal,
  liveRemote,
  retiredCount,
  remote,
  onRefresh,
}: {
  total: number
  liveLocal: number
  liveRemote: number
  retiredCount: number
  remote: string | null
  onRefresh: () => void
}) {
  return (
    <aside
      className="shrink-0 border-r border-[var(--color-line)] flex flex-col"
      style={{ width: 'var(--pane-narrow)', background: 'var(--color-bg-1)' }}
    >
      <div className="px-3.5 pt-2.5 pb-2 border-b border-[var(--color-line)] flex items-center gap-1.5">
        <span className="t-ghost text-[10px] tracking-[0.25em] flex-1">// FEDERATION</span>
        <button onClick={onRefresh} className="btn text-[10px]" title="Refresh machines">
          ↻
        </button>
      </div>

      <div className="px-3.5 py-2.5">
        <div className="t-ghost text-[9px] tracking-[0.2em] mb-2">// REMOTE</div>
        <div className="t-dim text-[10px] font-mono break-all leading-[1.5]">
          {remote ?? 'not configured'}
        </div>
      </div>

      <div className="border-t border-[var(--color-line)] px-3.5 py-2.5">
        <div className="t-ghost text-[9px] tracking-[0.2em] mb-2">// LEGEND</div>
        <div className="flex flex-col gap-1.5">
          <LegendRow color={COLOR_HUB} label="private-mind hub" />
          <LegendRow color={COLOR_SELF} label="this machine" />
          <LegendRow color={COLOR_PEER} label="peer machine" />
          <LegendRow color={COLOR_ACTIVE} label="live (active sessions)" />
          <LegendRow color={COLOR_BUS} label="live bus link" solid />
          <LegendRow color={COLOR_PEER} label="dormant (dimmed)" dim />
        </div>
      </div>

      <div className="border-t border-[var(--color-line)] px-3.5 py-2.5">
        <div className="t-ghost text-[9px] tracking-[0.2em] mb-2">// HINT</div>
        <div className="t-dim text-[10px] leading-[1.6]">
          Dashed edges connect the hub to every living node. Solid edges are live
          bus links between machines both currently in <em>live</em> status. Dormant
          nodes are dimmed; retired nodes (&gt;24h silent) are excluded.
        </div>
      </div>

      <div className="flex-1" />

      <div className="border-t border-[var(--color-line)] px-3.5 py-2 t-ghost text-[10px] font-mono flex flex-col gap-0.5">
        <div>
          live sessions:{' '}
          <span className="t-dim">
            {liveLocal} local · {liveRemote} remote
          </span>
        </div>
        <div>
          {total} live node{total === 1 ? '' : 's'}
          {retiredCount > 0 && (
            <span className="t-ghost" style={{ opacity: 0.5 }}>
              {' '}· {retiredCount} retired
            </span>
          )}
        </div>
      </div>
    </aside>
  )
}

function LegendRow({ color, label, solid, dim }: { color: string; label: string; solid?: boolean; dim?: boolean }) {
  return (
    <div
      className="flex items-center gap-1.5 text-[10px]"
      style={{ color: 'var(--color-dim)', opacity: dim ? 0.45 : 1 }}
    >
      {solid ? (
        <span
          aria-hidden
          style={{ display: 'inline-block', width: 12, height: 0, borderTop: `2px solid ${color}` }}
        />
      ) : (
        <span style={{ color }}>●</span>
      )}
      {label}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function MachinesView() {
  const storeMachines = useStore((s) => s.machines)
  const storeRetiredCount = useStore((s) => s.machinesRetiredCount)
  const [localMachines, setLocalMachines] = useState<MachineInfo[]>([])
  const [remote, setRemote] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [localRetiredCount, setLocalRetiredCount] = useState<number | null>(null)

  // Use store machines when available (setView already populated them, including
  // retiredCount). If empty (direct entry / deep-link), fetch here.
  const machines = storeMachines.length > 0 ? storeMachines : localMachines
  // Prefer the local value (set by an explicit load/refresh) so the sidebar
  // stays current after a manual refresh; fall back to the store value which
  // was populated by setView so normal navigation also shows the badge.
  const retiredCount = localRetiredCount ?? storeRetiredCount

  const load = useCallback(() => {
    setLoading(true)
    graphListMachines()
      .then(({ machines: m, remote: r, retiredCount: rc }) => {
        setLocalMachines(m)
        setRemote(r)
        setLocalRetiredCount(rc)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (storeMachines.length === 0) load()
  }, [storeMachines.length, load])

  // Build graph data
  const HUB_ID = '__private_mind_hub__'

  const simNodes: MachineSimNode[] = [
    {
      id: HUB_ID,
      label: 'private-mind',
      kind: 'hub',
      isSelf: false,
      isActive: false,
      info: null,
    },
    ...machines.map((m) => ({
      id: m.machineId,
      label: m.hostname,
      kind: 'machine' as const,
      isSelf: m.isSelf,
      isActive: m.status === 'live',
      info: m,
    })),
  ]

  // Federation edge: hub ↔ every living machine (API already excludes retired).
  // Opacity varies by status for dormant machines.
  const federationEdges: MachineEdge[] = machines
    .map((m) => ({ from: HUB_ID, to: m.machineId, edgeKind: 'federation' as const }))

  // Live bus edges: between any two DISTINCT machines that are both `live`.
  // Represents active cross-machine bus connectivity (one undirected edge per pair).
  const liveMachines = machines.filter((m) => m.status === 'live')
  const busEdges: MachineEdge[] = []
  for (let i = 0; i < liveMachines.length; i++) {
    const a = liveMachines[i]
    for (let j = i + 1; j < liveMachines.length; j++) {
      const b = liveMachines[j]
      if (!a || !b) continue
      busEdges.push({ from: a.machineId, to: b.machineId, edgeKind: 'bus' as const })
    }
  }

  const simEdges: MachineEdge[] = [...federationEdges, ...busEdges]

  const selectedMachine = machines.find((m) => m.machineId === selectedId) ?? null

  if (loading && machines.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center t-dim text-[12px]">
        <span className="caret">loading machines</span>
      </div>
    )
  }

  return (
    <>
      <MachinesSidebar
        total={machines.length}
        liveLocal={machines.find((m) => m.isSelf)?.sessionCount ?? 0}
        liveRemote={machines.filter((m) => !m.isSelf).reduce((n, m) => n + (m.sessionCount ?? 0), 0)}
        retiredCount={retiredCount}
        remote={remote}
        onRefresh={load}
      />

      <div className="flex-1 min-w-0 relative flex">
        <MachineCanvas
          nodes={simNodes}
          edges={simEdges}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
        />
        {selectedMachine && (
          <MachineInspector
            machine={selectedMachine}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </>
  )
}
