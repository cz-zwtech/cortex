import { useEffect, useRef, useState } from 'react'
import { cn } from './util'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  multiline?: boolean
  monospace?: boolean
  /** Render as a password field (value is masked). Multiline is ignored when set. */
  secret?: boolean
}

export function InlineText({ value, onChange, placeholder, className, multiline, monospace, secret }: Props) {
  const [local, setLocal] = useState(value ?? '')
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)

  useEffect(() => {
    setLocal(value ?? '')
  }, [value])

  const commit = () => {
    if (local !== value) onChange(local)
  }

  const cls = cn(
    'w-full bg-zinc-900/40 hover:bg-zinc-900/80 focus:bg-zinc-900 rounded px-2 py-1',
    'border border-dashed border-zinc-800 hover:border-zinc-700 focus:border-orange-400 focus:border-solid',
    'outline-none transition-colors text-zinc-100 placeholder:text-zinc-600 resize-none',
    monospace && 'font-mono text-[13px]',
    className,
  )

  if (multiline) {
    return (
      <textarea
        ref={ref as any}
        className={cls}
        value={local}
        placeholder={placeholder}
        rows={Math.max(2, local.split('\n').length)}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
      />
    )
  }
  return (
    <input
      ref={ref as any}
      type={secret ? 'password' : 'text'}
      autoComplete={secret ? 'off' : undefined}
      className={cls}
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setLocal(value)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}
