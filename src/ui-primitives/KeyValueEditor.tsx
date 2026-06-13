import { useState } from 'react'
import { InlineText } from './InlineText'

interface Props {
  value: Record<string, string>
  onChange: (v: Record<string, string>) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  /**
   * When true (default), values whose key looks like a secret (token, key,
   * secret, password, auth, credential, private) are masked with a password
   * input. A click on the eye toggles plaintext for that row only.
   */
  maskSecrets?: boolean
}

const SECRET_KEY_RE = /(token|secret|password|passwd|api[-_]?key|auth|credential|private[-_]?key|access[-_]?key)/i

const looksSecret = (key: string): boolean => SECRET_KEY_RE.test(key)

export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = 'KEY',
  valuePlaceholder = 'value',
  maskSecrets = true,
}: Props) {
  const entries = Object.entries(value)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())

  const toggleReveal = (key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const setKey = (oldKey: string, newKey: string) => {
    if (!newKey || newKey === oldKey) return
    const { [oldKey]: v, ...rest } = value
    onChange({ ...rest, [newKey]: v ?? '' })
  }
  const setVal = (key: string, v: string) => onChange({ ...value, [key]: v })
  const remove = (key: string) => {
    const { [key]: _, ...rest } = value
    onChange(rest)
  }
  const add = () => onChange({ ...value, '': '' })

  return (
    <div className="space-y-1">
      {entries.map(([k, v], i) => {
        const isSecret = maskSecrets && looksSecret(k)
        const masked = isSecret && !revealed.has(k)
        return (
          <div
            key={i}
            className="grid gap-2 items-center"
            style={{
              gridTemplateColumns: isSecret ? '1fr 1fr auto auto' : '1fr 1fr auto',
            }}
          >
            <InlineText
              value={k}
              onChange={(nk) => setKey(k, nk)}
              placeholder={keyPlaceholder}
              monospace
            />
            <InlineText
              value={v}
              onChange={(nv) => setVal(k, nv)}
              placeholder={valuePlaceholder}
              monospace
              secret={masked}
            />
            {isSecret && (
              <button
                onClick={() => toggleReveal(k)}
                className="t-ghost hover:text-[color:var(--color-amber)] px-2 text-xs"
                title={masked ? 'Reveal value' : 'Hide value'}
                aria-label={masked ? 'Reveal value' : 'Hide value'}
              >
                {masked ? <EyeIcon /> : <EyeOffIcon />}
              </button>
            )}
            <button
              onClick={() => remove(k)}
              className="t-ghost hover:text-[color:var(--color-rose)] px-2"
              aria-label="remove"
            >
              ×
            </button>
          </div>
        )
      })}
      <button onClick={add} className="text-xs t-ghost hover:text-[color:var(--color-mid)] mt-1">
        + add
      </button>
    </div>
  )
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-6.5 0-10-7-10-7a17.7 17.7 0 0 1 4.06-4.94" />
      <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.79 3.66" />
      <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  )
}
