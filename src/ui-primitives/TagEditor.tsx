import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * A floating tag editor that anchors to a trigger element's bounding rect.
 * Rendered through a portal so it escapes ancestor `overflow` clipping
 * (sidebars, dialogs, drawers).
 *
 * Tags are normalised: lowercased, whitespace → hyphens, deduplicated.
 *
 * Used in two places:
 *   - the Config sidebar (project rows)
 *   - the Knowledge view's Context sidebar (vault / user / project rows)
 */
export function TagEditorPortal({
  anchor,
  tags,
  onChange,
  onClose,
}: {
  anchor: DOMRect
  tags: string[]
  onChange: (tags: string[]) => void
  onClose: () => void
}) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!popoverRef.current) return
      if (!popoverRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const addTag = () => {
    const tag = input.trim().toLowerCase().replace(/\s+/g, '-')
    if (!tag || tags.includes(tag)) {
      setInput('')
      return
    }
    onChange([...tags, tag])
    setInput('')
  }

  const removeTag = (tag: string) => onChange(tags.filter((t) => t !== tag))

  const POPOVER_WIDTH = 300
  const top = anchor.bottom + 4
  const left = Math.min(
    Math.max(anchor.left, 8),
    window.innerWidth - POPOVER_WIDTH - 8,
  )

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed text-xs drawer-slide-in"
      style={{
        top,
        left,
        width: POPOVER_WIDTH,
        padding: '8px 10px',
        background: 'var(--color-bg-2)',
        border: '1px solid var(--color-line-bright)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5), 0 0 12px rgba(176,112,255,0.15)',
        zIndex: 200,
      }}
    >
      <div className="flex flex-wrap gap-1 mb-1.5">
        {tags.map((t) => (
          <span key={t} className="tag inline-flex items-center gap-1">
            {t}
            <button
              onClick={() => removeTag(t)}
              className="t-ghost hover:text-[color:var(--color-rose)] leading-none"
            >
              ×
            </button>
          </span>
        ))}
        {tags.length === 0 && <span className="t-ghost">No tags</span>}
      </div>
      <div className="flex gap-1">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addTag()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="add tag…"
          className="flex-1 bg-transparent outline-none px-1.5 py-0.5 text-[11px]"
          style={{ border: '1px solid var(--color-line)', color: 'var(--color-pale)' }}
        />
        <button onClick={addTag} className="btn !px-2 !py-0.5">
          +
        </button>
        <button onClick={onClose} className="btn !px-2 !py-0.5">
          done
        </button>
      </div>
    </div>,
    document.body,
  )
}
