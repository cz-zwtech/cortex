import { useEffect, useRef, useState } from 'react'
import { cn } from './util'

interface Option {
  value: string
  label: string
}

interface Props {
  value: string | undefined
  options: Option[]
  onChange: (v: string | undefined) => void
  placeholder?: string
  allowEmpty?: boolean
  className?: string
}

export function InlineSelect({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  allowEmpty,
  className,
}: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selected = options.find((o) => o.value === value)

  return (
    <div ref={ref} className={cn('relative inline-block', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="bg-zinc-800 hover:bg-zinc-700 rounded px-2 py-1 text-sm text-left w-full flex items-center justify-between gap-2 border border-zinc-700"
      >
        <span className={selected ? 'text-zinc-100' : 'text-zinc-500'}>
          {selected?.label ?? placeholder}
        </span>
        <span className="text-zinc-500">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 min-w-full w-max bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1">
          {allowEmpty && (
            <button
              type="button"
              onClick={() => {
                onChange(undefined)
                setOpen(false)
              }}
              className="block w-full text-left px-3 py-1.5 hover:bg-zinc-800 text-sm text-zinc-500 italic"
            >
              {placeholder}
            </button>
          )}
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              className={cn(
                'block w-full text-left px-3 py-1.5 hover:bg-zinc-800 text-sm',
                o.value === value && 'text-orange-400',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
