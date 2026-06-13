import { useEffect } from 'react'
import { useStore } from '@/app/store'
import { NavIcon } from './NavIcon'
import { openSettingsDialog, openSharedMindDialog } from '@/ui-primitives'

type View = 'home' | 'config' | 'knowledge' | 'graph' | 'code' | 'sessions' | 'machines' | 'profile'

const ITEMS: { k: View; label: string; live?: boolean }[] = [
  { k: 'home', label: 'Home' },
  { k: 'config', label: 'Config' },
  { k: 'knowledge', label: 'Knowledge' },
  { k: 'graph', label: 'Graph' },
  { k: 'code', label: 'Code' },
  { k: 'sessions', label: 'Sessions', live: true },
  { k: 'machines', label: 'Machines' },
  { k: 'profile', label: 'Profile' },
]

export function IconRail() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const expanded = useStore((s) => s.railExpanded)
  const toggleRail = useStore((s) => s.toggleRail)
  const profileEnabled = useStore((s) => s.profileEnabled)

  return (
    <div
      className="flex flex-col shrink-0 border-r border-[var(--color-line)]"
      style={{
        width: expanded ? 'var(--rail-expanded)' : 'var(--rail-collapsed)',
        background: 'linear-gradient(180deg, #0a0c1e, #07081a)',
        transition: 'width 160ms ease',
      }}
    >
      {/* Toggle */}
      <div
        className="flex pt-2 pb-1"
        style={{ justifyContent: expanded ? 'flex-end' : 'center', paddingRight: expanded ? 10 : 0 }}
      >
        <button
          onClick={toggleRail}
          className="t-ghost btn text-xs leading-none cursor-pointer"
          aria-label={expanded ? 'Collapse rail' : 'Expand rail'}
        >
          {expanded ? '«' : '»'}
        </button>
      </div>

      {ITEMS.filter((it) => it.k !== 'profile' || profileEnabled).map((it) => {
        const on = it.k === view
        const words = it.label.split(' ')
        return (
          <button
            key={it.k}
            onClick={() => setView(it.k)}
            className="relative flex flex-col items-center cursor-pointer"
            style={{
              padding: expanded ? '12px 0 14px' : '14px 0',
              gap: expanded ? 6 : 0,
              color: on ? 'var(--color-phos)' : 'var(--color-dim)',
            }}
          >
            {on && (
              <div
                className="absolute left-0 top-2 bottom-2"
                style={{ width: 2, background: 'var(--color-phos)', boxShadow: '0 0 8px var(--color-phos)' }}
              />
            )}
            <div
              className={on ? 't-glow-phos' : it.live ? 't-phos pulse-phos' : ''}
              style={{ lineHeight: 0, color: on ? undefined : it.live ? 'var(--color-phos)' : undefined }}
            >
              <NavIcon kind={it.k} size={22} />
            </div>
            {expanded && (
              <div className="text-[10px] tracking-[0.15em] uppercase text-center leading-[1.25]">
                {words.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}
            {it.live && !on && (
              <div
                className="absolute rounded-full"
                style={{
                  top: expanded ? 14 : 12,
                  right: expanded ? 24 : 14,
                  width: 5,
                  height: 5,
                  background: 'var(--color-phos)',
                  boxShadow: '0 0 6px var(--color-phos)',
                }}
              />
            )}
          </button>
        )
      })}

      <div className="flex-1" />

      {/* Shared mind — opens the publish-queue + sync dialog. */}
      <SharedMindRailButton expanded={expanded} />

      {/* Memory pulse */}
      <div className="px-1.5 py-2 border-t border-[var(--color-line)] text-center">
        <div className="t-phos pulse-phos text-[10px]">●</div>
        <div className="t-ghost text-[8px] tracking-[0.15em] mt-0.5">{expanded ? 'WRITING' : 'WRITE'}</div>
      </div>

      {/* Settings — opens existing dialog */}
      <button
        onClick={openSettingsDialog}
        className="flex flex-col items-center cursor-pointer t-dim hover:text-[color:var(--color-amber)] transition-colors"
        style={{ padding: expanded ? '10px 0 12px' : '10px 0', gap: expanded ? 6 : 0 }}
        title="Settings"
      >
        <div style={{ lineHeight: 0 }}>
          <NavIcon kind="settings" size={18} />
        </div>
        {expanded && (
          <div className="text-[10px] tracking-[0.15em] uppercase text-center leading-[1.25]">SETTINGS</div>
        )}
      </button>
    </div>
  )
}

/**
 * Rail entry for the shared-mind dialog. Shows a queue-count badge when
 * items are pending publish so the user knows there's work waiting.
 */
function SharedMindRailButton({ expanded }: { expanded: boolean }) {
  const queueCount = useStore((s) => s.sharedQueue.length)
  const ahead = useStore((s) => s.sharedStatus?.ahead ?? 0)
  const initialized = useStore((s) => s.sharedStatus?.initialized ?? false)
  const refreshSharedMind = useStore((s) => s.refreshSharedMind)

  // Pull a fresh status once on mount so the badge is accurate before the
  // user even opens the dialog.
  useEffect(() => {
    void refreshSharedMind()
  }, [refreshSharedMind])

  const tone = queueCount > 0 ? 'var(--color-amber)' : ahead > 0 ? 'var(--color-phos)' : 'var(--color-dim)'
  return (
    <button
      onClick={openSharedMindDialog}
      className="flex flex-col items-center cursor-pointer hover:text-[color:var(--color-amber)] transition-colors relative"
      style={{ padding: expanded ? '8px 0 4px' : '8px 0', gap: expanded ? 4 : 0, color: tone }}
      title={
        !initialized
          ? 'Shared mind — not yet initialized'
          : queueCount > 0
            ? `Shared mind — ${queueCount} item${queueCount === 1 ? '' : 's'} queued`
            : ahead > 0
              ? `Shared mind — ${ahead} commit${ahead === 1 ? '' : 's'} ready to push`
              : 'Shared mind'
      }
    >
      {/* Two-arrow up/down glyph — represents publish + sync. */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 10 L7 18 M3 14 L7 18 L11 14" />
        <path d="M17 6 L17 14 M13 10 L17 6 L21 10" />
      </svg>
      {expanded && (
        <div className="text-[10px] tracking-[0.15em] uppercase text-center leading-[1.25]">SHARE</div>
      )}
      {(queueCount > 0 || ahead > 0) && (
        <div
          className="absolute"
          style={{
            top: 4,
            right: expanded ? 18 : 8,
            background: tone,
            color: 'var(--color-bg-0)',
            fontSize: 9,
            fontWeight: 700,
            minWidth: 14,
            height: 14,
            borderRadius: 7,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 4px',
            lineHeight: 1,
          }}
        >
          {queueCount > 0 ? `↑${queueCount}` : `↑${ahead}`}
        </div>
      )}
    </button>
  )
}
