import { useStore } from '@/app/store'
import { allKindsForScope, kindSpecs, type Kind } from '@/ontology'
import { cn } from '@/ui-primitives'

export function SectionList() {
  const scope = useStore((s) => s.scope)
  const kind = useStore((s) => s.kind)
  const setKind = useStore((s) => s.setKind)

  const kinds = allKindsForScope(scope)

  return (
    <section
      className="shrink-0 border-r border-[var(--color-line)] flex flex-col"
      style={{ width: 'var(--pane-narrow)', background: 'var(--color-bg-1)' }}
    >
      <div className="px-3.5 pt-2.5 pb-2 border-b border-[var(--color-line)]">
        <span className="t-ghost text-[10px] tracking-[0.25em]">// CONFIG TYPES</span>
      </div>
      <div className="flex-1 overflow-auto">
        {kinds.map((k) => (
          <SectionRow key={k} kind={k} active={kind === k} onClick={() => setKind(k)} />
        ))}
      </div>
    </section>
  )
}

function SectionRow({ kind, active, onClick }: { kind: Kind; active: boolean; onClick: () => void }) {
  const count = useStore((s) => (s.entities as any)[kind].length as number)
  const loading = useStore((s) => s.loadingKinds.has(kind))
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left flex items-center justify-between cursor-pointer transition-colors',
      )}
      style={{
        padding: '7px 14px',
        borderLeft: active ? '2px solid var(--color-phos)' : '2px solid transparent',
        background: active ? 'rgba(176,112,255,0.08)' : 'transparent',
        color: active ? 'var(--color-pale)' : 'var(--color-mid)',
      }}
    >
      <span className="text-[12px]">{kindSpecs[kind].pluralLabel}</span>
      {loading ? (
        <Spinner />
      ) : (
        <span
          className="text-[10px] tabular-nums"
          style={{ color: count > 0 ? 'var(--color-amber)' : 'var(--color-ghost)' }}
        >
          {count}
        </span>
      )}
    </button>
  )
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="10"
      height="10"
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
