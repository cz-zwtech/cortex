/**
 * Branch selector for the Code-view graph. A chip showing the displayed branch
 * opens a popover of every branch the repo has symbols on (with counts).
 *  - left-click a row  → view that branch
 *  - right-click a row → set / clear it as the display default (persisted)
 * The pinned default is marked with ★; the branch currently shown is highlighted.
 *
 * Rendered ABOVE the graph (always visible, even when the graph is empty) so a
 * repo whose work lives on a non-default branch can be switched to a branch that
 * actually has symbols — the escape hatch from "No symbol graph on this branch".
 */
import { useEffect, useRef, useState } from 'react'
import { openContextMenu } from '@/ui-primitives/ContextMenu'
import { cn } from '@/ui-primitives/util'

export interface BranchOption {
  branch: string
  count: number
}

export function CodeBranchBar({
  repo,
  branches,
  effective,
  defaultBranch,
  onView,
  onSetDefault,
  onClearDefault,
}: {
  repo: string
  branches: BranchOption[]
  effective: string
  defaultBranch: string | null
  onView: (branch: string) => void
  onSetDefault: (branch: string) => void
  onClearDefault: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const label = (b: string) => b || '(unstamped)'

  return (
    <div className="flex items-center justify-between gap-3 px-3 h-8 shrink-0 border-b border-[var(--color-border)]">
      <span className="t-dim text-[11px] truncate">
        code graph ▸ {repo || '(no repo)'}
      </span>
      <div className="relative" ref={ref}>
        <button
          className="btn text-[11px]"
          onClick={() => setOpen((o) => !o)}
          title="Choose which branch's graph to display; right-click a branch to pin it as the default"
        >
          branch: {effective ? label(effective) : '(auto)'} ▾
        </button>
        {open && (
          <div className="absolute right-0 mt-1 z-50 min-w-[240px] max-h-[60vh] overflow-auto bg-zinc-900 border border-zinc-700 rounded shadow-2xl py-1">
            {branches.length === 0 && (
              <div className="px-3 py-1.5 t-dim text-[11px]">no branches for this repo</div>
            )}
            {branches.map((b) => {
              const isDefault = defaultBranch === b.branch
              const isShown = effective === b.branch
              return (
                <button
                  key={b.branch || '__unstamped'}
                  onClick={() => {
                    onView(b.branch)
                    setOpen(false)
                  }}
                  onContextMenu={(e) =>
                    openContextMenu(e, [
                      isDefault
                        ? { label: 'Clear default for display', onSelect: () => onClearDefault() }
                        : {
                            label: 'Set as default for display',
                            onSelect: () => onSetDefault(b.branch),
                          },
                    ])
                  }
                  className={cn(
                    'w-full text-left px-3 py-1.5 text-sm flex items-center justify-between gap-4 hover:bg-zinc-800',
                    isShown && 'bg-zinc-800/60',
                  )}
                  title="left-click to view · right-click to set/clear default"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="w-3 text-amber-400 text-center">{isDefault ? '★' : ''}</span>
                    <span className="truncate">{label(b.branch)}</span>
                  </span>
                  <span className="t-dim tabular-nums">{b.count.toLocaleString()}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
