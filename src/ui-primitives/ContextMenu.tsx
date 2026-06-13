import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { create } from 'zustand'
import { cn } from './util'

export interface ContextMenuItem {
  label: string
  onSelect?: () => void | Promise<void>
  submenu?: ContextMenuItem[]
  group?: string
  disabled?: boolean
  destructive?: boolean
  /** When rendered as a header button, shows a spinner and stays disabled. */
  pending?: boolean
  /** Optional leading icon. Rendered in the inspector header only; never in the context menu. */
  icon?: import('react').ReactNode
  /** Header-only: when true the button renders in the success (green) color (for stateful toggles). */
  active?: boolean
}

interface ContextMenuState {
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
  show: (x: number, y: number, items: ContextMenuItem[]) => void
  close: () => void
}

const useContextMenuStore = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  show: (x, y, items) => set({ open: true, x, y, items }),
  close: () => set({ open: false, items: [] }),
}))

export const openContextMenu = (e: MouseEvent, items: ContextMenuItem[]) => {
  if (items.length === 0) return
  e.preventDefault()
  e.stopPropagation()
  useContextMenuStore.getState().show(e.clientX, e.clientY, items)
}

export function ContextMenuHost() {
  const { open, x, y, items, close } = useContextMenuStore()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [sub, setSub] = useState<{
    items: ContextMenuItem[]
    x: number
    y: number
  } | null>(null)

  useEffect(() => {
    if (!open) setSub(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onClick = (e: Event) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        close()
        setSub(null)
      }
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        setSub(null)
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onEsc)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onEsc)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open, close])

  if (!open) return null

  const handleLeaf = async (it: ContextMenuItem) => {
    close()
    setSub(null)
    await it.onSelect?.()
  }

  return (
    <div ref={containerRef}>
      <Menu
        items={items}
        x={x}
        y={y}
        onHoverItem={(it, rect) => {
          if (it.submenu && it.submenu.length > 0) {
            setSub({ items: it.submenu, x: rect.right - 4, y: rect.top - 4 })
          } else {
            setSub(null)
          }
        }}
        onSelect={handleLeaf}
      />
      {sub && (
        <Menu
          items={sub.items}
          x={sub.x}
          y={sub.y}
          onHoverItem={() => {}}
          onSelect={handleLeaf}
        />
      )}
    </div>
  )
}

interface MenuProps {
  items: ContextMenuItem[]
  x: number
  y: number
  onHoverItem: (item: ContextMenuItem, rect: DOMRect) => void
  onSelect: (item: ContextMenuItem) => void | Promise<void>
}

function Menu({ items, x, y, onHoverItem, onSelect }: MenuProps) {
  const groups = new Map<string, ContextMenuItem[]>()
  for (const it of items) {
    const g = it.group ?? ''
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(it)
  }

  const vw = window.innerWidth
  const vh = window.innerHeight
  const MENU_W = 220
  const MENU_H_EST = items.length * 28 + 16
  const left = Math.min(Math.max(0, x), vw - MENU_W - 8)
  const top = Math.min(Math.max(0, y), vh - MENU_H_EST - 8)

  return (
    <div
      className="fixed z-[60] min-w-[200px] bg-zinc-900 border border-zinc-700 rounded shadow-2xl py-1"
      style={{ left, top }}
    >
      {[...groups.entries()].map(([group, its], gi) => (
        <div key={group || `__${gi}`}>
          {gi > 0 && <div className="my-1 border-t border-zinc-800" />}
          {group && (
            <div className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
              {group}
            </div>
          )}
          {its.map((it, i) => (
            <button
              key={`${group}-${i}`}
              disabled={it.disabled}
              onMouseEnter={(e) => onHoverItem(it, e.currentTarget.getBoundingClientRect())}
              onClick={() => {
                if (it.submenu) return
                void onSelect(it)
              }}
              className={cn(
                'group w-full text-left px-3 py-1.5 text-sm flex items-center justify-between gap-4 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed',
                it.destructive && 'text-red-400 hover:bg-red-950/40',
              )}
            >
              <span>{it.label}</span>
              {it.submenu && <span className="text-zinc-500">›</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
