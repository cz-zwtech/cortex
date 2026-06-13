import { cn } from './util'

interface Props {
  value: boolean
  onChange: (next: boolean) => void
  label?: string
  disabled?: boolean
}

export function Switch({ value, onChange, label, disabled }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={cn(
        'inline-flex items-center gap-2 group',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      )}
    >
      <span
        className={cn(
          'relative inline-block w-9 h-5 rounded-full transition-colors',
          value ? 'bg-emerald-600' : 'bg-zinc-700',
          !disabled && 'group-hover:ring-1 group-hover:ring-zinc-600',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-zinc-100 shadow transition-transform',
            value && 'translate-x-4',
          )}
        />
      </span>
      {label && <span className="text-sm text-zinc-300">{label}</span>}
    </button>
  )
}
