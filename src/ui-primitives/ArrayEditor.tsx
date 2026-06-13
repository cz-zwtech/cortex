import { InlineText } from './InlineText'

interface Props {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  monospace?: boolean
}

export function ArrayEditor({ value, onChange, placeholder, monospace }: Props) {
  const setAt = (i: number, v: string) => {
    const next = value.slice()
    next[i] = v
    onChange(next)
  }
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i))
  const add = () => onChange([...value, ''])

  return (
    <div className="space-y-1">
      {value.map((v, i) => (
        <div key={i} className="flex gap-2 items-center">
          <InlineText
            value={v}
            onChange={(nv) => setAt(i, nv)}
            placeholder={placeholder}
            monospace={monospace}
          />
          <button
            onClick={() => remove(i)}
            className="text-zinc-500 hover:text-red-400 px-2"
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={add}
        className="text-xs text-zinc-500 hover:text-zinc-300 mt-1"
      >
        + add
      </button>
    </div>
  )
}
