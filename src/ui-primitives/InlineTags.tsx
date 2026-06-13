import { useState, type KeyboardEvent } from 'react'
import { cn } from './util'

interface Props {
  value: string[] | undefined
  onChange: (v: string[] | undefined) => void
  placeholder?: string
  suggestions?: string[]
  className?: string
}

export function InlineTags({ value, onChange, placeholder, suggestions, className }: Props) {
  const [draft, setDraft] = useState('')
  const tags = value ?? []

  const add = (raw: string) => {
    const v = raw.trim()
    if (!v) return
    if (tags.includes(v)) return
    onChange([...tags, v])
    setDraft('')
  }

  const remove = (i: number) => {
    const next = tags.filter((_, idx) => idx !== i)
    onChange(next.length ? next : undefined)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add(draft)
    } else if (e.key === 'Backspace' && !draft && tags.length) {
      remove(tags.length - 1)
    }
  }

  const filteredSuggestions = (suggestions ?? []).filter(
    (s) => !tags.includes(s) && s.toLowerCase().includes(draft.toLowerCase()),
  )

  return (
    <div className={cn('relative', className)}>
      <div className="flex flex-wrap gap-1 items-center min-h-[28px]">
        {tags.map((t, i) => (
          <span
            key={t + i}
            className="inline-flex items-center gap-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs"
          >
            {t}
            <button
              onClick={() => remove(i)}
              className="text-zinc-500 hover:text-zinc-200 leading-none"
              aria-label={`remove ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(draft)}
          placeholder={tags.length === 0 ? placeholder : ''}
          className="flex-1 min-w-[80px] bg-transparent outline-none text-sm py-0.5"
        />
      </div>
      {draft && filteredSuggestions.length > 0 && (
        <div className="absolute z-40 mt-1 w-full bg-zinc-900 border border-zinc-700 rounded shadow-xl max-h-48 overflow-auto">
          {filteredSuggestions.slice(0, 8).map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                add(s)
              }}
              className="block w-full text-left px-3 py-1.5 hover:bg-zinc-800 text-sm"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
