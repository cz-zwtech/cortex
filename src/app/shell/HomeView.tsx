/**
 * Cortex home view — landing page on cold app start.
 *
 * Variant B · Synaptic mind: full-bleed neural web with floating corner
 * tags showing live sessions, graph health, last-write, and system info.
 *
 * The neural-web layout is generated **once at module load** with a seeded
 * RNG so it stays stable across re-renders — without this, every store
 * update would reflow the entire web because the original prototype called
 * `Math.random()` inline. See `generateWeb()` below.
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/app/store'
import type { LiveState } from '@/adapters/sessions'

const HEADLINE = 'THE MIND IS EVOLVING'

// ── Seeded RNG (mulberry32) — deterministic positions across renders ─────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Web layout — generated once and cached at module scope ───────────────────

interface WebNode {
  x: number
  y: number
  r: number
  tone: 'phos' | 'amber' | 'cyan'
  layer: number
  pulse: boolean
  center: boolean
}

interface WebEdge {
  a: WebNode
  b: WebNode
  tone: 'phos' | 'amber' | 'cyan'
  hot: boolean
}

const TONE_HEX: Record<'phos' | 'amber' | 'cyan' | 'rose', string> = {
  phos: '#2af0d6',
  amber: '#b070ff',
  cyan: '#5ac8ff',
  rose: '#ff6ec7',
}

const WEB_W = 720
const WEB_H = 600

function generateWeb(seed: number): {
  nodes: WebNode[]
  edges: WebEdge[]
  cx: number
  cy: number
} {
  const rand = mulberry32(seed)
  const cx = WEB_W / 2
  const cy = WEB_H / 2
  const layers: { count: number; r: number; tone: 'phos' | 'amber' | 'cyan' }[] = [
    { count: 6, r: 70, tone: 'phos' },
    { count: 10, r: 130, tone: 'amber' },
    { count: 14, r: 200, tone: 'amber' },
    { count: 18, r: 270, tone: 'cyan' },
  ]
  const nodes: WebNode[] = []
  layers.forEach((l, li) => {
    for (let i = 0; i < l.count; i++) {
      const a = (i / l.count) * Math.PI * 2 + (li % 2 ? 0.18 : 0)
      nodes.push({
        x: cx + Math.cos(a) * l.r,
        y: cy + Math.sin(a) * l.r,
        r: 2.4 + rand() * 1.6,
        tone: l.tone,
        layer: li,
        pulse: rand() < 0.22,
        center: false,
      })
    }
  })
  // Center node — always pulses, larger.
  const center: WebNode = {
    x: cx,
    y: cy,
    r: 5,
    tone: 'phos',
    layer: -1,
    pulse: true,
    center: true,
  }
  nodes.push(center)

  const edges: WebEdge[] = []
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!
    if (a.center) continue
    const candidates = nodes.filter(
      (b, bi) =>
        bi !== i &&
        Math.abs(b.layer - a.layer) <= 1 &&
        !b.center,
    )
    for (let k = 0; k < 2; k++) {
      const b = candidates[Math.floor(rand() * candidates.length)]
      if (b) edges.push({ a, b, tone: rand() < 0.18 ? 'phos' : a.tone, hot: false })
    }
    // ~6% chance of a "feeder" edge to the center node.
    if (rand() < 0.06) edges.push({ a, b: center, tone: 'phos', hot: true })
  }
  // Tag hot edges (the phos ones not feeding the center).
  for (const e of edges) e.hot = e.tone === 'phos'
  return { nodes, edges, cx, cy }
}

// Module-level cache. Seed 0xC07E (Cortex) per the design brief.
const WEB = generateWeb(0xc07e)
const WEB_LAYERS = [
  { r: 70, tone: 'phos' as const },
  { r: 130, tone: 'amber' as const },
  { r: 200, tone: 'amber' as const },
  { r: 270, tone: 'cyan' as const },
]

// ── NeuralWeb component ──────────────────────────────────────────────────────

function NeuralWeb() {
  const { nodes, edges, cx, cy } = WEB
  return (
    <svg
      viewBox={`0 0 ${WEB_W} ${WEB_H}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="cortex-haze" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#b070ff" stopOpacity="0.18" />
          <stop offset="60%" stopColor="#5ac8ff" stopOpacity="0.05" />
          <stop offset="100%" stopColor="#07081a" stopOpacity="0" />
        </radialGradient>
        <filter id="cortex-glow">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Ambient haze fill */}
      <rect x="0" y="0" width={WEB_W} height={WEB_H} fill="url(#cortex-haze)" />

      {/* Edges */}
      {edges.map((e, i) => (
        <line
          key={i}
          x1={e.a.x}
          y1={e.a.y}
          x2={e.b.x}
          y2={e.b.y}
          stroke={TONE_HEX[e.tone]}
          strokeWidth={e.hot ? 0.9 : 0.5}
          opacity={e.hot ? 0.55 : 0.3}
        />
      ))}

      {/* Concentric guide rings */}
      {WEB_LAYERS.map((l, i) => (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r={l.r}
          fill="none"
          stroke={TONE_HEX[l.tone]}
          strokeWidth="0.5"
          strokeDasharray="2 6"
          opacity="0.18"
        />
      ))}

      {/* Nodes */}
      {nodes.map((n, i) => (
        <g key={i} className={n.pulse ? 'node-breathe' : ''} style={{ color: TONE_HEX[n.tone] }}>
          <circle
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill={TONE_HEX[n.tone]}
            fillOpacity={n.center ? 0.9 : 0.55}
            stroke={TONE_HEX[n.tone]}
            strokeWidth={n.center ? 1.2 : 0.7}
            filter={n.pulse ? 'url(#cortex-glow)' : undefined}
          />
        </g>
      ))}

      {/* Center crosshair — four short ticks framing the heart node. */}
      <line x1={cx - 14} y1={cy} x2={cx - 9} y2={cy} stroke="#2af0d6" strokeWidth="1" opacity="0.6" />
      <line x1={cx + 9} y1={cy} x2={cx + 14} y2={cy} stroke="#2af0d6" strokeWidth="1" opacity="0.6" />
      <line x1={cx} y1={cy - 14} x2={cx} y2={cy - 9} stroke="#2af0d6" strokeWidth="1" opacity="0.6" />
      <line x1={cx} y1={cy + 9} x2={cx} y2={cy + 14} stroke="#2af0d6" strokeWidth="1" opacity="0.6" />
    </svg>
  )
}

// ── CornerTag ────────────────────────────────────────────────────────────────

type Tone = 'phos' | 'amber' | 'cyan' | 'rose' | 'dim' | 'mid' | 'hi' | 'ghost'

const POSITION_STYLE: Record<'tl' | 'tr' | 'bl' | 'br', React.CSSProperties> = {
  tl: { top: 96, left: 36 },
  tr: { top: 96, right: 36 },
  bl: { bottom: 36, left: 36 },
  br: { bottom: 36, right: 36 },
}

const TONE_BORDER: Record<'phos' | 'amber' | 'cyan' | 'rose', string> = {
  phos: '#2af0d6',
  amber: '#b070ff',
  cyan: '#5ac8ff',
  rose: '#ff6ec7',
}

function CornerTag({
  pos,
  label,
  tone,
  lines,
}: {
  pos: 'tl' | 'tr' | 'bl' | 'br'
  label: string
  tone: 'phos' | 'amber' | 'cyan' | 'rose'
  lines: [string, string, Tone?][]
}) {
  return (
    <div
      style={{
        position: 'absolute',
        ...POSITION_STYLE[pos],
        minWidth: 220,
        padding: '10px 14px',
        background: 'rgba(13,15,36,0.72)',
        border: '1px solid var(--color-line)',
        borderTop: `1px solid ${TONE_BORDER[tone]}`,
        backdropFilter: 'blur(2px)',
        pointerEvents: 'none',
      }}
    >
      <div className="t-ghost" style={{ fontSize: 9, letterSpacing: '0.2em' }}>
        // {label}
      </div>
      <div
        style={{
          marginTop: 6,
          display: 'grid',
          gridTemplateColumns: '60px 1fr',
          rowGap: 3,
          fontSize: 10,
        }}
      >
        {lines.map(([k, v, t], i) => (
          <span key={i} style={{ display: 'contents' }}>
            <span className="t-dim">{k}</span>
            <span className={`t-${t ?? 'mid'}`} style={{ wordBreak: 'break-word' }}>
              {v}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Helpers for live data ────────────────────────────────────────────────────

const liveTone = (s: LiveState): Tone => {
  if (s === 'live') return 'phos'
  if (s === 'stale') return 'amber'
  if (s === 'idle') return 'rose'
  return 'dim'
}

const liveLabel = (s: LiveState): string =>
  s === 'live' ? 'live' : s === 'stale' ? 'stale' : s === 'idle' ? 'idle' : 'idle'

const formatRelative = (mtimeMs: number): string => {
  const diff = Date.now() - mtimeMs
  if (diff < 0) return 'now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const startOfTodayMs = (): number => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// ── Main view ────────────────────────────────────────────────────────────────

export function HomeView() {
  const sessions = useStore((s) => s.sessions)
  const stats = useStore((s) => s.graphStats)
  const recent = useStore((s) => s.recentGraphActivity)
  const graphScopes = useStore((s) => s.graphScopes)
  const hookEntities = useStore((s) => s.entities.hook)

  // Tick every 30s so the relative-time strings on the corner tags
  // ("X min ago") refresh without needing a fresh WS event. Without this,
  // the BL "LAST WRITE · Nm ago" label freezes at whatever it was when the
  // view first rendered.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  // TL — three most-recent sessions, with state-tinted tone. Hidden ancient
  // ones are filtered out: we lead with anything still in live/stale/idle,
  // and only fall through to ancient if the user hasn't been active at all.
  const tlLines = useMemo<[string, string, Tone?][]>(() => {
    const ranked = [...sessions]
      .sort((a, b) => {
        const order: LiveState[] = ['live', 'stale', 'idle', 'ancient']
        const ai = order.indexOf(a.liveState)
        const bi = order.indexOf(b.liveState)
        if (ai !== bi) return ai - bi
        return b.mtimeMs - a.mtimeMs
      })
      .slice(0, 3)
    if (ranked.length === 0) {
      return [['—', 'no sessions yet', 'dim']]
    }
    return ranked.map((s) => {
      const idShort = s.id.slice(0, 4)
      const model = (s.model ?? 'unknown').replace(/^claude-/, '')
      const value = s.liveState === 'live' || s.liveState === 'stale'
        ? `${idShort} · ${model}`
        : `— · ${liveLabel(s.liveState)}`
      return [s.title.slice(0, 24), value, liveTone(s.liveState)]
    })
  }, [sessions])

  // TR — graph health. `+today` is computed from recentGraphActivity entries
  // synced after midnight. We don't track edge deltas independently; the
  // brief uses `+nodes / +edges` but server doesn't separate them, so we
  // show node delta only and let edges read as the rolling total.
  const todayCount = useMemo(() => {
    const start = startOfTodayMs()
    return recent.filter((r) => (r.syncedAt ?? r.updatedAt ?? 0) >= start).length
  }, [recent])
  const trLines: [string, string, Tone?][] = stats
    ? [
        ['nodes', stats.nodes.toLocaleString(), 'amber'],
        ['edges', stats.edges.toLocaleString(), 'amber'],
        ['+today', `+${todayCount} synced`, todayCount > 0 ? 'phos' : 'dim'],
      ]
    : [['nodes', '—', 'dim'], ['edges', '—', 'dim'], ['+today', '—', 'dim']]

  // BL — most-recent graph entry. The header carries a relative timestamp
  // so the user knows freshness without parsing the body.
  const lastWrite = recent[0]
  const lastWriteAgo = lastWrite
    ? formatRelative(lastWrite.syncedAt ?? lastWrite.updatedAt ?? 0)
    : 'never'
  const blLabel = `LAST WRITE · ${lastWriteAgo}`
  const blLines: [string, string, Tone?][] = lastWrite
    ? [
        ['+memory', `"${lastWrite.name.slice(0, 32)}"`, 'phos'],
        ['scope', shortenScope(lastWrite.scope), 'cyan'],
        ['kind', lastWrite.kind, 'dim'],
      ]
    : [['—', 'no entries', 'dim']]

  // BR — system pills. Vault is the largest vault scope by entry count;
  // model echoes whatever the title bar shows (most-recent session); hooks
  // is the count of hook entities currently loaded for the active scope.
  const vaultName = useMemo(() => {
    const v = graphScopes.find((s) => s.scope.startsWith('vault:'))
    return v ? v.scope.slice('vault:'.length) : '—'
  }, [graphScopes])
  const recentModel = sessions[0]?.model
  const modelLabel = (recentModel ?? 'claude-opus-4-7').replace(/^claude-/, '')
  const brLines: [string, string, Tone?][] = [
    ['vault', vaultName, vaultName === '—' ? 'dim' : 'cyan'],
    ['model', modelLabel, 'amber'],
    ['hooks', hookEntities.length > 0 ? `${hookEntities.length} active` : '—', hookEntities.length > 0 ? 'rose' : 'dim'],
  ]

  return (
    <div
      className="flex-1 min-w-0 relative overflow-hidden"
      style={{
        background:
          'radial-gradient(ellipse at center, #0a0c22 0%, #07081a 60%, #05061a 100%)',
      }}
    >
      {/* Centered web — fills 92%×94% of the area, identical to blueprint */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        aria-hidden="true"
      >
        <div style={{ width: '92%', height: '94%' }}>
          <NeuralWeb />
        </div>
      </div>

      {/* Headline */}
      <div
        style={{
          position: 'absolute',
          top: 36,
          left: '50%',
          transform: 'translateX(-50%)',
          textAlign: 'center',
          pointerEvents: 'none',
        }}
      >
        <div
          className="vt t-amber t-glow-amber"
          style={{ fontSize: 44, letterSpacing: '0.2em', lineHeight: 1 }}
        >
          {HEADLINE}
        </div>
      </div>

      <CornerTag pos="tl" label="SESSIONS · LIVE" tone="phos" lines={tlLines} />
      <CornerTag pos="tr" label="GRAPH · HEALTH" tone="amber" lines={trLines} />
      <CornerTag pos="bl" label={blLabel} tone="phos" lines={blLines} />
      <CornerTag pos="br" label="SYSTEM" tone="cyan" lines={brLines} />
    </div>
  )
}

// Trim long encoded scope names so they fit in the 1fr column. Falls back
// to the full string when it's already short.
function shortenScope(scope: string): string {
  if (scope.length <= 28) return scope
  if (scope.startsWith('project:')) {
    const rest = scope.slice('project:'.length)
    const tail = rest.split('-').filter(Boolean).slice(-2).join('-')
    return `project:…${tail}`
  }
  if (scope.startsWith('vault:')) return scope
  return scope.slice(0, 24) + '…'
}

