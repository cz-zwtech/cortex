/**
 * Sessions view — live monitoring of `~/.claude/projects/<encoded>/<id>.jsonl`
 * sessions. Tab strip across the top (ALL + auto-pinned live + user-pinned),
 * picker sheet for managing tabs/hide, per-session HUD + log stream, and a
 * right rail with graph stats and recent memory writes.
 *
 * Liveness states:
 *   live    < 60s  green pulse
 *   stale   < 120s yellow glow
 *   idle    < 300s dim red
 *   ancient ≥ 12h  grey
 *   (300s–12h presents as `idle`; auto-pin ends after 300s)
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/app/store'
import { sessionKey, type LiveState, type ParsedLine, type SessionMeta } from '@/adapters/sessions'

// ── Tone helpers ─────────────────────────────────────────────────────────────

const STATE_COLOR: Record<LiveState, string> = {
  live: 'var(--color-phos)',          // green/teal
  stale: 'var(--color-warn)',         // yellow
  idle: 'var(--color-rose-dim)',      // dim red
  ancient: 'var(--color-ghost)',      // grey
}

const STATE_LABEL: Record<LiveState, string> = {
  live: 'live',
  stale: 'stale',
  idle: 'idle',
  ancient: 'ancient',
}

const isAutoPinnable = (s: LiveState) => s === 'live' || s === 'stale' || s === 'idle'

// Project label: trim the leading `-` and collapse the encoded path so the
// rightmost segment shows. Full path lives in the tooltip.
const projectShort = (encoded: string): string => {
  const trimmed = encoded.replace(/^-+/, '')
  const parts = trimmed.split('-')
  return parts[parts.length - 1] ?? trimmed
}

const formatRelative = (mtimeMs: number): string => {
  const diff = Date.now() - mtimeMs
  if (diff < 0) return 'now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// ── State dot ────────────────────────────────────────────────────────────────

function StateDot({ state, size = 7 }: { state: LiveState; size?: number }) {
  const color = STATE_COLOR[state]
  const pulse = state === 'live'
  const glow = state === 'live' || state === 'stale'
  return (
    <span
      className={pulse ? 'pulse-phos' : ''}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        boxShadow: glow ? `0 0 6px ${color}` : 'none',
        flexShrink: 0,
      }}
      title={STATE_LABEL[state]}
    />
  )
}

// ── Tab strip ────────────────────────────────────────────────────────────────

function TabStrip({
  tabs,
  active,
  onSelect,
  onPickerOpen,
}: {
  tabs: TabSpec[]
  active: string
  onSelect: (key: string) => void
  onPickerOpen: () => void
}) {
  return (
    <div
      className="flex items-center shrink-0 border-b border-[var(--color-line)] overflow-x-auto"
      style={{ background: 'var(--color-bg-1)', height: 32 }}
    >
      {tabs.map((t) => {
        const on = t.key === active
        return (
          <button
            key={t.key}
            onClick={() => onSelect(t.key)}
            title={t.tooltip}
            className="flex items-center gap-2 px-3 h-full transition-colors hover:bg-[rgba(176,112,255,0.06)] shrink-0"
            style={{
              borderBottom: on ? '2px solid var(--color-phos)' : '2px solid transparent',
              color: on ? 'var(--color-pale)' : 'var(--color-mid)',
              fontSize: 11,
            }}
          >
            {t.state && <StateDot state={t.state} />}
            {t.pinned && <span className="t-amber" style={{ fontSize: 9 }}>📌</span>}
            <span className="truncate" style={{ maxWidth: 220 }}>{t.label}</span>
          </button>
        )
      })}
      <button
        onClick={onPickerOpen}
        className="flex items-center justify-center px-3 h-full t-ghost hover:t-amber transition-colors shrink-0"
        title="Open session picker"
        style={{ fontSize: 14 }}
      >
        +
      </button>
    </div>
  )
}

interface TabSpec {
  key: string
  label: string
  tooltip: string
  state?: LiveState
  pinned: boolean
}

// ── HUD ──────────────────────────────────────────────────────────────────────

function HUD({
  meta,
  direction,
  filter,
  onToggleDirection,
  onToggleFilter,
  onTogglePin,
  onHide,
  pinned,
}: {
  meta: SessionMeta
  direction: 'newest-top' | 'oldest-top'
  filter: 'loud' | 'quiet'
  onToggleDirection: () => void
  onToggleFilter: () => void
  onTogglePin: () => void
  onHide: () => void
  pinned: boolean
}) {
  return (
    <div
      className="flex items-center gap-3 px-3.5 shrink-0 border-b border-[var(--color-line)] text-[11px]"
      style={{
        height: 28,
        background: 'linear-gradient(180deg, rgba(176,112,255,0.04), transparent)',
      }}
    >
      <StateDot state={meta.liveState} />
      <span className="t-hi truncate" style={{ maxWidth: 320 }} title={meta.title}>
        {meta.title}
      </span>
      <span className="t-ghost">│</span>
      <span className="t-dim" title={meta.projectDir}>{projectShort(meta.projectDir)}</span>
      <span className="t-ghost">│</span>
      <span className="t-mid">{meta.model ?? 'unknown'}</span>
      <span className="t-ghost">│</span>
      <span className="t-mid">{meta.turnCount.toLocaleString()} turns</span>
      <span className="t-ghost">·</span>
      <span className="t-mid">{(meta.tokenCount / 1000).toFixed(1)}k tok</span>
      <span className="t-ghost">·</span>
      <span className="t-dim">{formatRelative(meta.mtimeMs)} ago</span>
      <span className="flex-1" />
      <button
        onClick={onToggleFilter}
        className="btn text-[10px]"
        title="Toggle loud / quiet filter"
      >
        {filter === 'loud' ? 'loud' : 'quiet'}
      </button>
      <button
        onClick={onToggleDirection}
        className="btn text-[10px]"
        title={direction === 'newest-top' ? 'Newest at top — click for oldest top' : 'Oldest at top — click for newest top'}
      >
        {direction === 'newest-top' ? '↑ newest' : '↓ oldest'}
      </button>
      <button
        onClick={onTogglePin}
        className="btn text-[10px]"
        title={pinned ? 'Unpin tab' : 'Pin tab'}
        style={pinned ? { color: 'var(--color-amber)', borderColor: 'var(--color-amber-dim)' } : undefined}
      >
        {pinned ? 'pinned' : 'pin'}
      </button>
      <button
        onClick={onHide}
        className="btn text-[10px] hover:!text-[color:var(--color-rose)] hover:!border-[color:var(--color-rose-dim)]"
        title="Hide this session from the picker (file untouched)"
      >
        hide
      </button>
    </div>
  )
}

// ── Log stream ───────────────────────────────────────────────────────────────

const QUIET_TYPES = new Set(['user', 'assistant'])

function LogStream({
  lines,
  direction,
  filter,
  loading,
}: {
  lines: ParsedLine[]
  direction: 'newest-top' | 'oldest-top'
  filter: 'loud' | 'quiet'
  loading: boolean
}) {
  // Build a tool_use_id → result.isError map so we can colour the call
  // glyph (✓/✗) without waiting for the result line to be next to the
  // call line in the stream.
  const resultStatus = useMemo(() => {
    const map = new Map<string, boolean>() // toolUseId → isError
    for (const l of lines) {
      if (l.type === 'tool_result' && l.toolUseId) {
        map.set(l.toolUseId, !!l.isError)
      }
    }
    return map
  }, [lines])

  // Phase B preview: detect fail→success patterns in real time. A `tool_use`
  // marked as the second of a same-tool pair where the first errored is
  // tagged with `failSuccess` so the renderer can bracket them. Cheap —
  // single linear pass.
  const failSuccessIds = useMemo(() => {
    const ids = new Set<string>()
    let lastByTool = new Map<string, { id: string; errored: boolean }>()
    for (const l of lines) {
      if (l.type === 'tool_use' && l.tool && l.toolUseId) {
        const prev = lastByTool.get(l.tool)
        if (prev && prev.errored) {
          // Wait for this call's result to know if it succeeded — we can
          // look it up from the resultStatus map computed above.
          const succeeded = resultStatus.get(l.toolUseId) === false
          if (succeeded) ids.add(l.toolUseId)
        }
        lastByTool.set(l.tool, { id: l.toolUseId, errored: false })
      } else if (l.type === 'tool_result' && l.toolUseId) {
        // Update the most-recent tool_use of any name whose id matches.
        for (const [k, v] of lastByTool) {
          if (v.id === l.toolUseId) lastByTool.set(k, { ...v, errored: !!l.isError })
        }
      }
    }
    return ids
  }, [lines, resultStatus])

  const visible = useMemo(() => {
    let out = lines
    if (filter === 'quiet') {
      out = lines.filter((l) => {
        if (QUIET_TYPES.has(l.type)) return true
        if (l.type === 'tool_result' && l.isError) return true
        return false
      })
    }
    if (direction === 'newest-top') {
      out = [...out].reverse()
    }
    return out
  }, [lines, filter, direction])

  if (loading && lines.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center t-dim text-[12px]">
        <span className="caret">loading session</span>
      </div>
    )
  }

  if (visible.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center t-dim text-[12px]">
        no messages.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto px-3.5 py-2 font-mono">
      {visible.map((l, i) => (
        <LogRow
          key={`${l.line}-${l.type}-${i}`}
          line={l}
          callError={l.type === 'tool_use' && l.toolUseId ? resultStatus.get(l.toolUseId) : undefined}
          failSuccessMark={l.toolUseId ? failSuccessIds.has(l.toolUseId) : false}
        />
      ))}
    </div>
  )
}

function LogRow({
  line,
  callError,
  failSuccessMark,
}: {
  line: ParsedLine
  callError?: boolean
  failSuccessMark: boolean
}) {
  const ts = line.timestamp ? new Date(line.timestamp) : null
  const tsLabel = ts
    ? ts.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--'

  if (line.type === 'user') {
    return (
      <div className="flex items-start gap-2 py-0.5 text-[11px] leading-[1.6]">
        <span className="t-ghost shrink-0 tabular-nums">{tsLabel}</span>
        <span className="t-phos shrink-0">{'>'}</span>
        <span className="t-mid truncate" title={line.text}>{line.text}</span>
      </div>
    )
  }
  if (line.type === 'assistant') {
    return (
      <div className="flex items-start gap-2 py-0.5 text-[11px] leading-[1.6]">
        <span className="t-ghost shrink-0 tabular-nums">{tsLabel}</span>
        <span className="t-amber shrink-0">{'<'}</span>
        <span className="t-hi truncate" title={line.text}>{line.text}</span>
      </div>
    )
  }
  if (line.type === 'tool_use') {
    // ✓ if the matching tool_result was a success; ✗ if it errored; · if pending.
    const glyph = callError === undefined ? '·' : callError ? '✗' : '✓'
    const glyphTone =
      callError === undefined ? 'var(--color-dim)'
      : callError ? 'var(--color-rose)'
      : 'var(--color-phos)'
    return (
      <div
        className="flex items-start gap-2 py-0.5 text-[11px] leading-[1.6]"
        style={
          failSuccessMark
            ? {
                borderLeft: '2px solid var(--color-phos-dim)',
                paddingLeft: 6,
                marginLeft: -8,
                background: 'rgba(42,240,214,0.04)',
              }
            : undefined
        }
        title={failSuccessMark ? 'fail → success — Phase B candidate' : undefined}
      >
        <span className="t-ghost shrink-0 tabular-nums">{tsLabel}</span>
        <span className="shrink-0" style={{ color: glyphTone }}>{glyph}</span>
        <span className="t-cyan shrink-0">{line.tool}</span>
        {line.text && <span className="t-dim truncate" title={line.text}>· {line.text}</span>}
      </div>
    )
  }
  if (line.type === 'tool_result') {
    if (!line.isError) return null  // success results are summarised on the call line itself
    return (
      <div className="flex items-start gap-2 py-0.5 text-[11px] leading-[1.6]">
        <span className="t-ghost shrink-0 tabular-nums">{tsLabel}</span>
        <span className="t-rose shrink-0">!</span>
        <span className="t-rose truncate" title={line.text}>{line.text || '(error)'}</span>
      </div>
    )
  }
  if (line.type === 'meta') {
    return (
      <div className="flex items-start gap-2 py-0.5 text-[10px] leading-[1.6] t-ghost italic">
        <span className="shrink-0 tabular-nums">{tsLabel}</span>
        <span>· {line.text}</span>
      </div>
    )
  }
  return null
}

// ── Right rail (graph stats + writes/5m + newest memories) ───────────────────

function RightRail() {
  const stats = useStore((s) => s.graphStats)
  const recent = useStore((s) => s.recentGraphActivity)
  const refreshActivity = useStore((s) => s.refreshRecentActivity)

  // Tick the clock every 60s so the sparkline buckets keep aligning to "now"
  // even when no new sync events are coming in. Cheap — recompute is O(n)
  // over ≤200 entries, no extra fetches.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  // Also refresh from the server every 5 minutes as a safety net in case a
  // graph:sync event was missed (WS dropped, sync ran while we were offline).
  useEffect(() => {
    const id = setInterval(() => void refreshActivity(), 5 * 60_000)
    return () => clearInterval(id)
  }, [refreshActivity])

  // Writes-per-5-minute sparkline. Bucket entries by syncedAt (when they
  // landed in the graph) — that's the signal users care about: when did the
  // graph receive new memory? Falls back to updatedAt if syncedAt is absent.
  const sparkline = useMemo(() => {
    const now = Date.now()
    const bucketMs = 5 * 60 * 1000
    const buckets = new Array(12).fill(0) // last hour in 5min buckets
    for (const r of recent) {
      const ts = r.syncedAt ?? r.updatedAt
      if (!ts) continue
      const ageMs = now - ts
      if (ageMs < 0 || ageMs > bucketMs * buckets.length) continue
      const idx = Math.floor(ageMs / bucketMs)
      buckets[buckets.length - 1 - idx] = (buckets[buckets.length - 1 - idx] ?? 0) + 1
    }
    return buckets
  }, [recent])

  const max = Math.max(1, ...sparkline)
  const totalLastHour = sparkline.reduce((a, b) => a + b, 0)
  const newest = recent.slice(0, 8)

  return (
    <aside
      className="shrink-0 border-l border-[var(--color-line)] flex flex-col"
      style={{ width: 'var(--pane-narrow)', background: 'var(--color-bg-1)' }}
    >
      <div className="px-3.5 py-2 border-b border-[var(--color-line)]">
        <div className="t-ghost text-[10px] tracking-[0.2em]">// GRAPH</div>
        <div className="mt-1.5 text-[12px] t-mid">
          {stats ? `${stats.nodes.toLocaleString()} nodes · ${stats.edges.toLocaleString()} edges` : '—'}
        </div>
      </div>
      <div className="px-3.5 py-2 border-b border-[var(--color-line)]">
        <div className="flex items-center gap-1.5">
          <span className="t-ghost text-[10px] tracking-[0.2em] flex-1">// WRITES /5m · last hr</span>
          <span className="t-mid text-[10px] tabular-nums">{totalLastHour}</span>
        </div>
        <div className="mt-1.5 flex items-end gap-0.5" style={{ height: 28 }}>
          {sparkline.map((v, i) => {
            const bucketEnd = Date.now() - (sparkline.length - 1 - i) * 5 * 60_000
            const label = new Date(bucketEnd).toLocaleTimeString(undefined, {
              hour12: false,
              hour: '2-digit',
              minute: '2-digit',
            })
            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: v > 0 ? `${Math.max(8, (v / max) * 100)}%` : '4%',
                  background: v > 0 ? 'var(--color-phos)' : 'var(--color-line)',
                  opacity: v > 0 ? 0.85 : 0.5,
                }}
                title={`${label} · ${v} write${v === 1 ? '' : 's'}`}
              />
            )
          })}
        </div>
      </div>
      <div className="px-3.5 py-2 flex-1 overflow-auto">
        <div className="t-ghost text-[10px] tracking-[0.2em]">// NEWEST MEMORY</div>
        <div className="mt-1.5 flex flex-col gap-1">
          {newest.length === 0 && <span className="t-dim text-[10px] italic">no entries.</span>}
          {newest.map((r) => {
            const ts = r.syncedAt ?? r.updatedAt
            const ago = ts ? formatRelative(ts) : '—'
            return (
              <div
                key={r.id}
                className="flex items-baseline gap-1.5 text-[10px]"
                style={{ color: 'var(--color-mid)' }}
                title={`${r.name}\n${r.kind} · ${r.scope}\n${ago} ago`}
              >
                <span className="t-ghost">·</span>
                <span className="truncate flex-1">{r.name}</span>
                <span className="t-ghost shrink-0 tabular-nums">{ago}</span>
              </div>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

// ── ALL feed ─────────────────────────────────────────────────────────────────

function AllFeed({ visibleSessions }: { visibleSessions: SessionMeta[] }) {
  const streams = useStore((s) => s.sessionStreams)
  const direction = useStore((s) => s.sessionDirection)['all'] ?? 'newest-top'
  const filter = useStore((s) => s.sessionFilter)['all'] ?? 'loud'
  const toggleDirection = useStore((s) => s.toggleSessionDirection)
  const toggleFilter = useStore((s) => s.toggleSessionFilter)

  const merged = useMemo(() => {
    const out: { line: ParsedLine; sessionKey: string; title: string }[] = []
    for (const s of visibleSessions) {
      const k = sessionKey(s)
      const lines = streams[k]
      if (!lines) continue
      for (const l of lines) out.push({ line: l, sessionKey: k, title: s.title })
    }
    out.sort((a, b) => {
      const ta = Date.parse(a.line.timestamp || '0')
      const tb = Date.parse(b.line.timestamp || '0')
      return tb - ta // newest first by default
    })
    if (direction === 'oldest-top') out.reverse()
    if (filter === 'quiet') {
      return out.filter((m) => QUIET_TYPES.has(m.line.type) || (m.line.type === 'tool_result' && m.line.isError))
    }
    return out
  }, [visibleSessions, streams, direction, filter])

  const tones = useMemo(() => {
    const palette = [
      'var(--color-phos)',
      'var(--color-amber)',
      'var(--color-cyan)',
      'var(--color-rose)',
      'var(--color-warn)',
    ]
    const map = new Map<string, string>()
    visibleSessions.forEach((s, i) => map.set(sessionKey(s), palette[i % palette.length] ?? 'var(--color-mid)'))
    return map
  }, [visibleSessions])

  return (
    <>
      <div
        className="flex items-center gap-3 px-3.5 shrink-0 border-b border-[var(--color-line)] text-[11px]"
        style={{ height: 28, background: 'linear-gradient(180deg, rgba(42,240,214,0.04), transparent)' }}
      >
        <span className="t-phos">●</span>
        <span className="t-hi">ALL</span>
        <span className="t-ghost">│</span>
        <span className="t-mid">{visibleSessions.length} sessions</span>
        <span className="t-ghost">·</span>
        <span className="t-mid">
          {visibleSessions.filter((s) => s.liveState === 'live').length} live
        </span>
        <span className="t-ghost">·</span>
        <span className="t-mid">{merged.length} events</span>
        <span className="flex-1" />
        <button
          onClick={() => toggleFilter('all')}
          className="btn text-[10px]"
          title="Toggle loud / quiet filter"
        >
          {filter === 'loud' ? 'loud' : 'quiet'}
        </button>
        <button
          onClick={() => toggleDirection('all')}
          className="btn text-[10px]"
          title={direction === 'newest-top' ? 'Newest at top' : 'Oldest at top'}
        >
          {direction === 'newest-top' ? '↑ newest' : '↓ oldest'}
        </button>
      </div>
      <div className="flex-1 overflow-auto px-3.5 py-2 font-mono">
        {merged.length === 0 && (
          <div className="t-dim italic text-[11px]">no activity yet — open a session in the picker.</div>
        )}
        {merged.map((m, i) => {
          const tone = tones.get(m.sessionKey) ?? 'var(--color-mid)'
          return (
            <div key={`${m.sessionKey}-${m.line.line}-${i}`} className="flex items-start gap-2 py-0.5 text-[11px] leading-[1.6]">
              <span className="shrink-0" style={{ color: tone }} title={m.title}>
                ●
              </span>
              <span className="t-ghost shrink-0 tabular-nums" style={{ width: 70 }}>
                {m.title.slice(0, 8)}
              </span>
              <LogRowInline line={m.line} />
            </div>
          )
        })}
      </div>
    </>
  )
}

// Compact single-line variant of LogRow used in the ALL feed (already
// indented under the session-tone dot, so we skip our own glyph column).
function LogRowInline({ line }: { line: ParsedLine }) {
  if (line.type === 'user') {
    return <span className="t-mid truncate" title={line.text}><span className="t-phos">{'>'}</span> {line.text}</span>
  }
  if (line.type === 'assistant') {
    return <span className="t-hi truncate" title={line.text}><span className="t-amber">{'<'}</span> {line.text}</span>
  }
  if (line.type === 'tool_use') {
    return (
      <span className="truncate" title={line.text}>
        <span className="t-dim">·</span> <span className="t-cyan">{line.tool}</span>
        {line.text && <span className="t-dim"> · {line.text}</span>}
      </span>
    )
  }
  if (line.type === 'tool_result' && line.isError) {
    return <span className="t-rose truncate" title={line.text}>! {line.text || '(error)'}</span>
  }
  return null
}

// ── Picker sheet ─────────────────────────────────────────────────────────────

function PickerSheet({ onClose }: { onClose: () => void }) {
  const sessions = useStore((s) => s.sessions)
  const pinned = useStore((s) => s.pinnedSessions)
  const hidden = useStore((s) => s.hiddenSessionIds)
  const togglePin = useStore((s) => s.toggleSessionPin)
  const hide = useStore((s) => s.hideSession)
  const unhide = useStore((s) => s.unhideSession)
  const refreshSessions = useStore((s) => s.refreshSessions)

  // Local toggle: include hidden rows so the user can unhide.
  const [showHidden, setShowHidden] = useState(false)

  const visible = useMemo(() => {
    return sessions.filter((s) => {
      const k = sessionKey(s)
      const isHidden = hidden.has(k)
      return showHidden ? isHidden : !isHidden
    })
  }, [sessions, hidden, showHidden])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(7,8,26,0.85)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      <div
        className="w-[760px] max-h-[80vh] flex flex-col"
        style={{
          background: 'var(--color-bg-1)',
          border: '1px solid var(--color-line)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 24px rgba(176,112,255,0.15)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--color-line)]"
          style={{ background: 'linear-gradient(180deg, #14172e, transparent)' }}
        >
          <span className="vt t-amber t-glow-amber tracking-[0.18em] text-[14px]">◈ SESSIONS</span>
          <span className="t-ghost">│</span>
          <span className="t-dim text-[11px] flex-1">Manage tabs · pin / hide</span>
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="btn text-[10px]"
            title="Toggle hidden sessions"
          >
            {showHidden ? '◉ hidden' : '○ hidden'}
          </button>
          <button onClick={() => void refreshSessions()} className="btn text-[10px]" title="Refresh list">
            ↻
          </button>
          <button onClick={onClose} className="btn t-ghost text-[14px] leading-none px-2">×</button>
        </div>

        <div className="flex-1 overflow-auto">
          {visible.length === 0 && (
            <div className="px-4 py-6 t-dim text-[11px] italic">
              {showHidden ? 'No hidden sessions.' : 'No sessions.'}
            </div>
          )}
          {visible.map((s) => {
            const k = sessionKey(s)
            const isPinned = pinned.includes(k)
            const isHidden = hidden.has(k)
            return (
              <div
                key={k}
                className="flex items-center gap-2 px-4 py-1.5 border-t border-[var(--color-line)] first:border-t-0"
              >
                <StateDot state={s.liveState} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] t-mid truncate" title={s.title}>
                    {s.title}
                  </div>
                  <div className="text-[10px] t-ghost truncate" title={s.projectDir}>
                    {projectShort(s.projectDir)} · {s.turnCount} turns · {(s.tokenCount / 1000).toFixed(1)}k tok · {formatRelative(s.mtimeMs)} ago
                  </div>
                </div>
                {!isHidden && (
                  <button
                    onClick={() => togglePin(k)}
                    className="btn text-[10px]"
                    style={isPinned ? { color: 'var(--color-amber)', borderColor: 'var(--color-amber-dim)' } : undefined}
                  >
                    {isPinned ? 'pinned' : 'pin'}
                  </button>
                )}
                {isHidden ? (
                  <button onClick={() => void unhide(k)} className="btn text-[10px]">unhide</button>
                ) : (
                  <button
                    onClick={() => void hide(k)}
                    className="btn text-[10px] hover:!text-[color:var(--color-rose)]"
                  >
                    hide
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <div className="px-4 py-2.5 border-t border-[var(--color-line)] flex items-center justify-end gap-2">
          <span className="t-ghost text-[10px] flex-1">
            files on disk are never deleted — hide is a UI filter only.
          </span>
          <button onClick={onClose} className="btn text-[11px]">close</button>
        </div>
      </div>
    </div>
  )
}

// ── Main view ────────────────────────────────────────────────────────────────

export function SessionsView() {
  const sessions = useStore((s) => s.sessions)
  const sessionTab = useStore((s) => s.sessionTab)
  const setSessionTab = useStore((s) => s.setSessionTab)
  const pinned = useStore((s) => s.pinnedSessions)
  const togglePin = useStore((s) => s.toggleSessionPin)
  const hidden = useStore((s) => s.hiddenSessionIds)
  const hide = useStore((s) => s.hideSession)
  const direction = useStore((s) => s.sessionDirection)
  const filter = useStore((s) => s.sessionFilter)
  const toggleDirection = useStore((s) => s.toggleSessionDirection)
  const toggleFilter = useStore((s) => s.toggleSessionFilter)
  const sessionStreams = useStore((s) => s.sessionStreams)
  const sessionLoading = useStore((s) => s.sessionLoading)
  const loadSessionStream = useStore((s) => s.loadSessionStream)
  const pickerOpen = useStore((s) => s.sessionPickerOpen)
  const setPickerOpen = useStore((s) => s.setSessionPickerOpen)

  // Sessions visible to this view (not hidden by user).
  const visibleSessions = useMemo(
    () => sessions.filter((s) => !hidden.has(sessionKey(s))),
    [sessions, hidden],
  )

  // The set of session tabs to show: auto-pinned (live/stale/idle) plus
  // user-pinned (regardless of state). Hidden sessions are excluded.
  const tabSessions = useMemo(() => {
    const map = new Map<string, SessionMeta>()
    for (const s of visibleSessions) {
      const k = sessionKey(s)
      if (pinned.includes(k) || isAutoPinnable(s.liveState)) {
        map.set(k, s)
      }
    }
    // Sort: live first, then by mtime desc.
    return Array.from(map.values()).sort((a, b) => {
      const order: LiveState[] = ['live', 'stale', 'idle', 'ancient']
      const ai = order.indexOf(a.liveState)
      const bi = order.indexOf(b.liveState)
      if (ai !== bi) return ai - bi
      return b.mtimeMs - a.mtimeMs
    })
  }, [visibleSessions, pinned])

  const tabs: TabSpec[] = useMemo(() => {
    const t: TabSpec[] = [
      {
        key: 'all',
        label: 'ALL',
        tooltip: 'All visible sessions, merged',
        pinned: false,
      },
    ]
    for (const s of tabSessions) {
      const k = sessionKey(s)
      t.push({
        key: k,
        label: s.title || s.id.slice(0, 8),
        tooltip: `${s.title} · ${s.projectDir}`,
        state: s.liveState,
        pinned: pinned.includes(k),
      })
    }
    return t
  }, [tabSessions, pinned])

  // Lazy-load the stream for the active tab + every tab session (so ALL feed
  // can merge them). Skip ones already loaded or in flight.
  useEffect(() => {
    for (const s of tabSessions) {
      const k = sessionKey(s)
      if (!sessionStreams[k] && !sessionLoading[k]) {
        void loadSessionStream(k)
      }
    }
  }, [tabSessions, sessionStreams, sessionLoading, loadSessionStream])

  // If the active tab's session is no longer in tabs (e.g. went stale and
  // wasn't pinned, or got hidden), fall back to ALL.
  const activeKey = sessionTab in keyedTabs(tabs) ? sessionTab : 'all'
  useEffect(() => {
    if (activeKey !== sessionTab) setSessionTab(activeKey)
  }, [activeKey, sessionTab, setSessionTab])

  const activeSession = activeKey !== 'all' ? sessions.find((s) => sessionKey(s) === activeKey) : null

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <TabStrip
        tabs={tabs}
        active={activeKey}
        onSelect={setSessionTab}
        onPickerOpen={() => setPickerOpen(true)}
      />

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          {activeKey === 'all' ? (
            <AllFeed visibleSessions={visibleSessions} />
          ) : activeSession ? (
            <>
              <HUD
                meta={activeSession}
                direction={direction[activeKey] ?? 'newest-top'}
                filter={filter[activeKey] ?? 'loud'}
                onToggleDirection={() => toggleDirection(activeKey)}
                onToggleFilter={() => toggleFilter(activeKey)}
                onTogglePin={() => togglePin(activeKey)}
                onHide={() => void hide(activeKey)}
                pinned={pinned.includes(activeKey)}
              />
              <LogStream
                lines={sessionStreams[activeKey] ?? []}
                direction={direction[activeKey] ?? 'newest-top'}
                filter={filter[activeKey] ?? 'loud'}
                loading={!!sessionLoading[activeKey]}
              />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center t-dim text-[12px]">
              session not found.
            </div>
          )}
        </div>
        <RightRail />
      </div>

      {pickerOpen && <PickerSheet onClose={() => setPickerOpen(false)} />}
    </div>
  )
}

const keyedTabs = (tabs: TabSpec[]): Record<string, true> => {
  const o: Record<string, true> = {}
  for (const t of tabs) o[t.key] = true
  return o
}
