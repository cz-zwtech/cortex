import { useStore } from '@/app/store'

/**
 * Persistent cross-filter context bar that sits above each view.
 * Shows the active scope, any cross-filter from another view, and tag
 * visibility chips. Tags are freeform — chips are rendered from the
 * actual hidden-tag set in the store, no reserved names.
 */
export function SelectionBar() {
  const view = useStore((s) => s.view)
  const scope = useStore((s) => s.scope)
  const projects = useStore((s) => s.projects)
  const projectTags = useStore((s) => s.projectTags)
  const hiddenTags = useStore((s) => s.hiddenTags)
  const toggleHiddenTag = useStore((s) => s.toggleHiddenTag)
  const stats = useStore((s) => s.graphStats)

  const allTags = Array.from(new Set(Object.values(projectTags).flat())).sort()
  const anyChip = scope.type === 'project' || hiddenTags.size > 0
  const scopeLabel =
    scope.type === 'user'
      ? 'global'
      : scope.type === 'project'
        ? projects.find((p) => p.id === scope.projectId)?.name ?? scope.projectId
        : ''

  const reset = () => {
    Array.from(hiddenTags).forEach((t) => toggleHiddenTag(t))
  }

  if (!anyChip && allTags.length === 0) {
    return (
      <div
        className="flex items-center gap-2.5 px-3.5 shrink-0 border-b border-[var(--color-line)] text-[11px]"
        style={{
          padding: '8px 14px',
          background: 'linear-gradient(180deg, rgba(42,240,214,0.05), transparent)',
        }}
      >
        <span className="t-ghost text-[10px] tracking-[0.2em]">// FILTERS</span>
        <span className="tag tag-phos text-[9px]">○ none</span>
        <span className="t-dim text-[10px]">— every memory shown · the whole mind</span>
        <span className="flex-1" />
        {stats && (
          <span className="t-phos pulse-phos text-[10px]">● {stats.nodes.toLocaleString()} active</span>
        )}
        <span className="t-ghost">│</span>
        <span className="t-dim text-[10px]">
          view <span className="t-cyan">{view}</span>
        </span>
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-2.5 shrink-0 border-b border-[var(--color-line)] text-[11px]"
      style={{
        padding: '8px 14px',
        background: 'linear-gradient(180deg, rgba(176,112,255,0.04), transparent)',
      }}
    >
      <span className="t-ghost text-[10px] tracking-[0.2em]">// FILTERS</span>

      {scope.type === 'project' && (
        <span
          className="tag tag-amber"
          style={{ background: 'rgba(176,112,255,0.10)' }}
        >
          scope <span className="t-hi ml-1">{scopeLabel}</span>
        </span>
      )}

      {allTags.length > 0 && (
        <>
          <span className="t-ghost">│</span>
          <span className="t-ghost text-[10px]">tags:</span>
          {allTags.map((t) => {
            const hidden = hiddenTags.has(t)
            return (
              <button
                key={t}
                onClick={() => toggleHiddenTag(t)}
                className="tag"
                style={{
                  fontSize: 9,
                  opacity: hidden ? 0.45 : 1,
                  borderColor: hidden ? 'var(--color-line)' : 'var(--color-amber-dim)',
                  color: hidden ? 'var(--color-dim)' : 'var(--color-amber)',
                }}
                title={hidden ? `Show "${t}"` : `Hide "${t}"`}
              >
                {hidden ? '○' : '◉'} {t}
              </button>
            )
          })}
        </>
      )}

      <span className="flex-1" />
      <span className="t-dim text-[10px]">
        view <span className="t-cyan">{view}</span>
      </span>
      {hiddenTags.size > 0 && (
        <button onClick={reset} className="btn text-[10px]">
          reset all
        </button>
      )}
    </div>
  )
}
