import { useStore } from '@/app/store'
import pkg from '../../../package.json'

/**
 * Cortex header bar — single 32px row across every view.
 *
 * Left:  ◈ CORTEX wordmark + version + COGNITION ENGINE eyebrow.
 * Right: GRAPH / VAULT / model / live-pill health indicators.
 *
 * The original title bar carried a path string and `— ☐ ✕` window glyphs;
 * those are gone. The path is left to the `<StatusBar>` at the bottom
 * (which already shows view + scope + memory counts) so we don't duplicate.
 *
 * A `breadcrumb` slot stays in the signature for inner views that may want
 * to surface a deeper path (e.g. config :: sokn :: permissions :: Bash(grep
 * *)) but defaults off — single-row only for now.
 */
export function TitleBar({
  breadcrumb,
  showBreadcrumb = false,
}: {
  breadcrumb?: string[]
  showBreadcrumb?: boolean
}) {
  const stats = useStore((s) => s.graphStats)
  const sessions = useStore((s) => s.sessions)

  // We don't track WS connection state explicitly. Use stats presence as the
  // proxy for "graph reachable" — if we've ever loaded stats, the server is
  // up. Pulse stays on; if the WS dies, the auto-reconnect will quietly heal
  // and the dot keeps pulsing. Cosmetic only.
  const graphConnected = stats !== null
  const vaultConnected = useStore(
    (s) => s.graphScopes.some((v) => v.scope.startsWith('vault:')),
  )
  const liveCount = sessions.filter((s) => s.liveState === 'live').length
  // Read the most-recent session's model id. Falls back to opus-4.7 when no
  // session metadata is available yet (cold start, no .jsonl files).
  const recentModel = sessions[0]?.model
  const modelLabel = (recentModel ?? 'claude-opus-4-7').replace(/^claude-/, '')

  return (
    <div
      className="flex flex-col shrink-0 border-b border-[var(--color-line)]"
      style={{ background: 'linear-gradient(180deg, #14172e 0%, #0a0c20 100%)' }}
    >
      {/* Top row — brand */}
      <div
        className="flex items-center px-3.5"
        style={{ height: 32, gap: 12 }}
      >
        <span
          className="vt t-amber t-glow-amber"
          style={{ fontSize: 22, lineHeight: 1, letterSpacing: '0.32em', fontWeight: 400 }}
        >
          ◈ CORTEX
        </span>
        <span
          className="t-ghost"
          style={{ fontSize: 10, letterSpacing: '0.2em' }}
        >
          v{pkg.version} · COGNITION ENGINE
        </span>
        <span style={{ flex: 1 }} />
        {/* Health pills, right side */}
        <span className="t-dim" style={{ fontSize: 10, letterSpacing: '0.12em' }}>GRAPH</span>
        <span
          className={graphConnected ? 't-phos pulse-phos' : 't-ghost'}
          style={{ fontSize: 11 }}
          title={graphConnected ? 'graph reachable' : 'graph unreachable'}
        >
          ●
        </span>
        <span className="t-dim" style={{ fontSize: 10, letterSpacing: '0.12em' }}>VAULT</span>
        <span
          className={vaultConnected ? 't-phos' : 't-ghost'}
          style={{ fontSize: 11 }}
          title={vaultConnected ? 'vault attached' : 'no vault attached'}
        >
          ●
        </span>
        <span className="t-dim" style={{ fontSize: 10, letterSpacing: '0.12em' }}>{modelLabel}</span>
        <span className="t-amber" style={{ fontSize: 11 }}>●</span>
        {liveCount > 0 && (
          <span
            style={{
              border: '1px solid var(--color-phos-dim)',
              color: 'var(--color-phos)',
              padding: '1px 7px',
              fontSize: 10,
              letterSpacing: '0.1em',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
            title={`${liveCount} session${liveCount === 1 ? '' : 's'} writing right now`}
          >
            <span className="pulse-phos">●</span> {liveCount} LIVE
          </span>
        )}
      </div>

      {/* Optional breadcrumb row — off by default. Left in for future inner-view use. */}
      {showBreadcrumb && breadcrumb && breadcrumb.length > 0 && (
        <div
          className="flex items-center px-3.5"
          style={{
            height: 18,
            gap: 8,
            borderTop: '1px solid rgba(42,49,88,0.5)',
            background: 'rgba(7,8,26,0.5)',
            fontSize: 10,
            letterSpacing: '0.06em',
          }}
        >
          {breadcrumb.map((seg, i) => (
            <span key={i} className="flex items-center gap-2">
              {i > 0 && <span className="t-ghost">::</span>}
              <span className={i === breadcrumb.length - 1 ? 't-amber' : 't-dim'}>
                {seg}
              </span>
            </span>
          ))}
          <span style={{ flex: 1 }} />
          <span className="t-ghost">⌘ K</span>
          <span className="t-dim">command</span>
          <span className="t-ghost" style={{ marginLeft: 12 }}>⌘ /</span>
          <span className="t-dim">help</span>
        </div>
      )}
    </div>
  )
}
