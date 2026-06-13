import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Entity, Scope } from '@/ontology'

interface DialogStore {
  open: boolean
  source: Entity<any> | null
  target: Scope | null
  targetLabel: string
  conflict: Entity<any> | null
  resolver: ((confirmed: boolean) => void) | null
  begin: (args: {
    source: Entity<any>
    target: Scope
    targetLabel: string
    conflict: Entity<any> | null
  }) => Promise<boolean>
  resolve: (confirmed: boolean) => void
}

const useDialog = create<DialogStore>((set, get) => ({
  open: false,
  source: null,
  target: null,
  targetLabel: '',
  conflict: null,
  resolver: null,
  begin: ({ source, target, targetLabel, conflict }) => {
    return new Promise<boolean>((resolve) => {
      set({ open: true, source, target, targetLabel, conflict, resolver: resolve })
    })
  },
  resolve: (confirmed) => {
    const { resolver } = get()
    resolver?.(confirmed)
    set({ open: false, resolver: null, source: null, target: null, conflict: null, targetLabel: '' })
  },
}))

/**
 * Open the promote/move ceremony dialog. Resolves to `true` if the user
 * confirms, `false` if they cancel. Caller is responsible for performing
 * the actual move/copy after confirmation.
 */
export const openPromoteDialog = (args: {
  source: Entity<any>
  target: Scope
  targetLabel: string
  conflict: Entity<any> | null
}): Promise<boolean> => useDialog.getState().begin(args)

// ── Host ────────────────────────────────────────────────────────────────────

export function PromoteDialogHost() {
  const { open, source, targetLabel, conflict, resolve } = useDialog()
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false)

  useEffect(() => {
    if (!open) setConfirmingOverwrite(false)
  }, [open])

  if (!open || !source) return null

  const sourceLabel = (source.value as any)?.name ?? source.id
  const sourceScopeLabel =
    source.scope.type === 'user' ? 'global' : source.scope.type === 'project' ? source.scope.projectId : '—'

  const handleCancel = () => resolve(false)
  const handleConfirm = () => {
    if (conflict && !confirmingOverwrite) {
      setConfirmingOverwrite(true)
      return
    }
    resolve(true)
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(7,8,26,0.85)', backdropFilter: 'blur(2px)' }}
      onClick={handleCancel}
    >
      <div
        className="w-[820px] max-w-[92vw] max-h-[85vh] flex flex-col"
        style={{
          background: 'var(--color-bg-1)',
          border: `1px solid ${conflict ? 'var(--color-warn)' : 'var(--color-amber-dim)'}`,
          boxShadow: conflict
            ? '0 20px 60px rgba(0,0,0,0.6), 0 0 24px rgba(217,166,87,0.15)'
            : '0 20px 60px rgba(0,0,0,0.6), 0 0 24px rgba(176,112,255,0.15)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--color-line)]"
          style={{ background: 'linear-gradient(180deg, #14172e, transparent)' }}
        >
          <span className="vt t-amber t-glow-amber tracking-[0.18em] text-[14px]">◈ PROMOTE</span>
          <span className="t-ghost">::</span>
          <span className="t-hi text-[12px] truncate flex-1" title={sourceLabel}>
            {sourceLabel}
          </span>
          <span className="t-ghost">→</span>
          <span className="t-phos text-[12px] truncate" title={targetLabel}>
            {targetLabel}
          </span>
        </div>

        {/* Conflict banner */}
        {conflict && (
          <div
            className="flex items-center gap-2 px-4 py-2 text-[11px] border-b border-[var(--color-line)]"
            style={{
              background: 'rgba(217,166,87,0.06)',
              color: 'var(--color-warn)',
            }}
          >
            <span>⚠</span>
            <span>
              destination already has an entry named{' '}
              <span className="t-hi">{(conflict.value as any)?.name ?? conflict.id}</span>{' '}
              · confirming will overwrite it.
            </span>
          </div>
        )}

        {/* Side-by-side diff */}
        <div className="flex-1 min-h-0 grid grid-cols-2 divide-x divide-[var(--color-line)] overflow-hidden">
          <DiffPane
            title={`// SOURCE · ${sourceScopeLabel}`}
            content={source.raw}
            tone="amber"
          />
          <DiffPane
            title={`// DESTINATION · ${targetLabel}`}
            content={conflict?.raw ?? null}
            placeholder={
              conflict
                ? 'destination has an existing version (shown above)'
                : '(empty — new file will be created)'
            }
            tone={conflict ? 'warn' : 'phos'}
          />
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-[var(--color-line)] flex items-center justify-end gap-2">
          {confirmingOverwrite && conflict && (
            <span className="t-warn text-[11px] flex-1">
              ⚠ overwrite {(conflict.value as any)?.name ?? conflict.id}?
            </span>
          )}
          <button onClick={handleCancel} className="btn t-ghost text-[11px]">
            cancel
          </button>
          <button
            onClick={handleConfirm}
            className="btn text-[11px] !text-[color:var(--color-phos)] !border-[color:var(--color-phos-dim)] hover:!border-[color:var(--color-phos)]"
          >
            {confirmingOverwrite ? 'overwrite →' : 'confirm →'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Diff pane ───────────────────────────────────────────────────────────────

function DiffPane({
  title,
  content,
  placeholder,
  tone,
}: {
  title: string
  content: string | null
  placeholder?: string
  tone: 'amber' | 'phos' | 'warn'
}) {
  const toneColor =
    tone === 'amber'
      ? 'var(--color-amber)'
      : tone === 'warn'
        ? 'var(--color-warn)'
        : 'var(--color-phos)'

  return (
    <div className="flex flex-col min-h-0 overflow-hidden">
      <div
        className="px-4 py-2 text-[10px] tracking-[0.2em] truncate shrink-0"
        style={{ color: toneColor, borderBottom: '1px solid var(--color-line)' }}
        title={title}
      >
        {title}
      </div>
      <pre
        className="flex-1 min-h-0 overflow-auto px-4 py-3 text-[11px] leading-[1.6] whitespace-pre-wrap break-words m-0 t-mid font-mono"
      >
        {content ?? <span className="t-ghost italic">{placeholder ?? '—'}</span>}
      </pre>
    </div>
  )
}
