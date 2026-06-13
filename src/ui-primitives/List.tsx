import type { MouseEvent, ReactNode } from 'react'
import { cn } from './util'

interface Item {
  id: string
  label: ReactNode
  sublabel?: ReactNode
  badge?: ReactNode
  error?: boolean
}

interface Props {
  items: Item[]
  selectedId: string | null
  onSelect: (id: string) => void
  onHover?: (id: string) => void
  onContextMenu?: (id: string, event: MouseEvent) => void
  empty?: ReactNode
}

export function List({ items, selectedId, onSelect, onHover, onContextMenu, empty }: Props) {
  if (items.length === 0) {
    return (
      <div className="px-4 py-5 text-[11px] italic" style={{ color: 'var(--color-dim)' }}>
        {empty ?? 'Nothing here yet.'}
      </div>
    )
  }
  return (
    <ul>
      {items.map((it) => {
        const on = selectedId === it.id
        return (
          <li key={it.id}>
            <button
              onClick={() => onSelect(it.id)}
              onMouseEnter={onHover ? () => onHover(it.id) : undefined}
              onContextMenu={(e) => onContextMenu?.(it.id, e)}
              className={cn(
                'w-full text-left flex items-center gap-2 transition-colors',
                it.error && 't-warn',
              )}
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--color-line)',
                borderLeft: on ? '2px solid var(--color-phos)' : '2px solid transparent',
                background: on ? 'linear-gradient(90deg, rgba(176,112,255,0.14), transparent 70%)' : undefined,
                color: on ? 'var(--color-pale)' : 'var(--color-mid)',
              }}
            >
              <div className="flex-1 min-w-0">
                <div className="truncate text-[12px]">{it.label}</div>
                {it.sublabel && (
                  <div className="truncate text-[10px] mt-0.5" style={{ color: 'var(--color-ghost)' }}>{it.sublabel}</div>
                )}
              </div>
              {it.badge}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
