interface Props {
  data: Record<string, unknown>
}

const formatValue = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(formatValue).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * Renders YAML frontmatter as a compact key/value panel. Used by
 * MarkdownView so read-mode doesn't render the `---` fence block as
 * literal markdown (which looks like a stray horizontal rule section).
 */
export function FrontmatterPanel({ data }: Props) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null)
  if (entries.length === 0) return null
  return (
    <div className="frontmatter-panel not-prose mb-3 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 space-y-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-3 items-baseline text-xs">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500 shrink-0 min-w-[90px]">
            {key}
          </span>
          <span className="text-zinc-300 font-mono break-all">{formatValue(value)}</span>
        </div>
      ))}
    </div>
  )
}
