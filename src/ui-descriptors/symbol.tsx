import { useEffect, useState } from 'react'
import type { CodeSymbol } from '@/ontology'
import type { UiDescriptor } from './types'
import { graphSymbolNeighborhood, type GraphSymbol } from '@/adapters/graph'
import { FilePath } from '@/ui-primitives'

const pct = (n: number | undefined): string =>
  `${Math.round((n ?? 0) * 100)}%`

const fmtDate = (ms: number | undefined): string => {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return String(ms) }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">{label}</div>
      <div className="text-sm text-zinc-300">{children}</div>
    </div>
  )
}

function SymbolList({ label, symbols }: { label: string; symbols: GraphSymbol[] }) {
  if (symbols.length === 0) {
    return (
      <Field label={label}>
        <span className="text-zinc-600">none</span>
      </Field>
    )
  }
  return (
    <Field label={`${label} (${symbols.length})`}>
      <ul className="space-y-1">
        {symbols.map((s) => (
          <li key={s.id} className="flex items-baseline gap-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-violet-400 shrink-0">
              {s.symbolKind}
            </span>
            <span className="font-mono text-zinc-200">{s.name}</span>
            <span className="text-[11px] text-zinc-500 truncate">{s.file}</span>
          </li>
        ))}
      </ul>
    </Field>
  )
}

function SymbolInspector({ value }: { value: CodeSymbol; onChange: any; ctx: any }) {
  const [neighborhood, setNeighborhood] = useState<{
    dependents: GraphSymbol[]
    dependencies: GraphSymbol[]
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    setNeighborhood(null)
    graphSymbolNeighborhood(value.id)
      .then((n) => {
        if (cancelled || !n) return
        setNeighborhood({ dependents: n.dependents, dependencies: n.dependencies })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [value.id])

  return (
    <div className="max-w-3xl mx-auto px-6 py-5 space-y-5">
      <div className="flex items-center gap-2.5">
        <span className="text-[11px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-violet-950/70 text-violet-400">
          {value.symbolKind}
        </span>
        <span className="text-lg font-mono text-zinc-100">{value.name}</span>
        {value.pinned && (
          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">pinned</span>
        )}
        {value.groundTruthValid === false && (
          <span className="text-[10px] font-bold uppercase tracking-wider text-red-400">stale</span>
        )}
      </div>

      {value.signature && (
        <pre className="bg-zinc-950 border border-zinc-800 rounded-md p-3 text-[12px] font-mono text-zinc-300 overflow-x-auto whitespace-pre-wrap break-words">
          {value.signature}
        </pre>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Field label="Repo">{value.repo || '—'}</Field>
        <Field label="Language">{value.lang || '—'}</Field>
        <Field label="File">
          {(() => {
            // Prefer the real on-disk path (repo root + repo-relative file) when
            // the root was persisted; fall back to the repo-relative file alone
            // for symbols ingested before the 0012 Symbol.root migration.
            const abs = value.root
              ? `${value.root.replace(/\/$/, '')}/${value.file}`
              : value.file
            return (
              <FilePath path={abs} className="text-sm text-zinc-300 break-all">
                {abs}{value.line ? `:${value.line}` : ''}
              </FilePath>
            )
          })()}
        </Field>
        <Field label="Symbol id"><span className="font-mono text-[12px] break-all">{value.id}</span></Field>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Field label="Centrality (in-degree)">{value.centrality ?? 0}</Field>
        <Field label="Stickiness">{pct(value.stickiness)}</Field>
        <Field label="Last seen">{fmtDate(value.lastSeen)}</Field>
      </div>

      <div className="border-t border-zinc-800 pt-4 space-y-4">
        <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Blast radius</div>
        {neighborhood === null ? (
          <div className="text-sm text-zinc-600">loading…</div>
        ) : (
          <>
            <SymbolList label="Dependents (callers / importers)" symbols={neighborhood.dependents} />
            <SymbolList label="Dependencies (this calls / imports)" symbols={neighborhood.dependencies} />
          </>
        )}
      </div>
    </div>
  )
}

export const symbolDescriptor: UiDescriptor<CodeSymbol> = {
  kind: 'symbol',
  newLabel: '',
  newPromptLabel: '',
  newDefault: () => ({
    id: '', name: '', symbolKind: '', repo: '', file: '',
  }),
  listLabel: (v) => v.name || v.id,
  listSublabel: (v) => {
    const parts: string[] = []
    if (v.symbolKind) parts.push(v.symbolKind)
    if (v.repo) parts.push(v.repo)
    if (v.centrality) parts.push(`${v.centrality} dependent${v.centrality === 1 ? '' : 's'}`)
    return parts.join(' · ')
  },
  headerSubtitle: (v) => v.file,
  Editor: SymbolInspector,
}
