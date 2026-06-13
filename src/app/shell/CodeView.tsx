/**
 * Cortex Code view — a dedicated surface for the repo/AST symbol graph.
 *
 * Left: symbols grouped by repo, with a search box (name/file/symbolKind) and
 * a repo filter. Right: the read-only symbol inspector (reused from the
 * symbol ui-descriptor) showing signature, lifecycle, and live blast-radius.
 *
 * This view reads the code graph through the same API as everything else
 * (`graphListSymbols`) — it never touches the graph DB directly. It is intentionally
 * separate from the memory-centric Knowledge/Graph views: code symbols are
 * derived data and deserve their own home.
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/app/store'
import {
  graphListSymbols,
  graphSymbolGraph,
  graphForgetRepoSymbols,
  graphListMachines,
  graphSymbolViews,
  graphGetDefaultBranch,
  graphSetDefaultBranch,
  type GraphSymbol,
  type MachineInfo,
  type SymbolView,
} from '@/adapters/graph'
import { symbolDescriptor } from '@/ui-descriptors/symbol'
import type { CodeSymbol } from '@/ontology'
import { CodeGraphView } from './CodeGraphView'
import { CodeBranchBar, type BranchOption } from './CodeBranchBar'

// Dependency filter modes. Degree is split: in-degree is the symbol's
// `centrality` (who depends on it); out-degree is derived from the symbol-graph
// edge list (what it depends on).
type DepFilter = 'all' | 'connected' | 'dependents' | 'dependencies' | 'isolated'
const DEP_FILTERS: { key: DepFilter; label: string; title: string }[] = [
  { key: 'all', label: 'all', title: 'All symbols' },
  { key: 'connected', label: 'linked', title: 'Has any dependency edge (in or out)' },
  { key: 'dependents', label: 'depended-on', title: 'Something depends on this (in-edges)' },
  { key: 'dependencies', label: 'depends-on', title: 'This depends on something (out-edges)' },
  { key: 'isolated', label: 'isolated', title: 'No dependency edges at all' },
]

const SymbolInspector = symbolDescriptor.Editor

// Map a GraphSymbol (adapter shape) to the CodeSymbol ontology shape the
// inspector expects. They're field-compatible; lang/line/signature optional.
const toCodeSymbol = (s: GraphSymbol): CodeSymbol => ({
  id: s.id,
  name: s.name,
  symbolKind: s.symbolKind,
  repo: s.repo,
  file: s.file,
  lang: s.lang,
  line: s.line,
  signature: s.signature,
  base: s.base,
  stickiness: s.stickiness,
  centrality: s.centrality,
  lastSeen: s.lastSeen,
  pinned: s.pinned,
  groundTruthValid: s.groundTruthValid,
  root: s.root,
})

// A repo is "local" if Cortex knows it was extracted on this machine — i.e. any
// of its symbols carries the self machine id (or an empty pre-lineage stamp,
// which predates federation and was always local). A repo whose symbols belong
// only to a known remote machine (adopted via private-mind) has no source here.
// Cortex records no on-disk root path (the extractor's `--root` arg is consumed
// and discarded), so the closest local identifier we can surface is the repo
// name; remote repos show the literal "remote".
const repoTooltip = (repo: string, isLocal: boolean): string =>
  isLocal ? `local · ${repo || '(no repo)'}` : 'remote'

function FilterSidebar({
  repos,
  repoLocal,
  activeRepo,
  onSelectRepo,
  query,
  onQuery,
  total,
  depFilter,
  onDepFilter,
  onForgetRepo,
  forgetting,
  machines,
  machineFilter,
  onSelectMachine,
}: {
  repos: { repo: string; count: number }[]
  repoLocal: Map<string, boolean>
  activeRepo: string | null
  onSelectRepo: (repo: string | null) => void
  query: string
  onQuery: (q: string) => void
  total: number
  depFilter: DepFilter
  onDepFilter: (d: DepFilter) => void
  onForgetRepo: (repo: string, count: number) => void
  forgetting: string | null
  machines: MachineInfo[]
  machineFilter: string | null
  onSelectMachine: (machineId: string | null) => void
}) {
  return (
    <aside
      className="shrink-0 border-r border-[var(--color-line)] flex flex-col overflow-hidden"
      style={{ width: 'var(--pane-narrow)', background: 'var(--color-bg-1)' }}
    >
      <div className="px-3.5 pt-2.5 pb-2 border-b border-[var(--color-line)] flex items-center gap-1.5 shrink-0">
        <span className="t-ghost text-[10px] tracking-[0.25em] flex-1 whitespace-nowrap">// CODE GRAPH</span>
        <span className="t-ghost text-[9px] font-mono">{total}</span>
      </div>

      <div className="px-3.5 py-2.5 border-b border-[var(--color-line)]">
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="search name / file / kind…"
          className="w-full bg-[var(--color-bg-0)] border border-[var(--color-line)] px-2 py-1 text-[11px] text-[color:var(--color-pale)] placeholder:text-[color:var(--color-ghost)] focus:outline-none focus:border-[color:var(--color-phos)]"
        />
      </div>

      {machines.length > 0 && (
        <div className="px-3.5 py-2 border-b border-[var(--color-line)]">
          <span className="t-ghost text-[10px] tracking-[0.25em] block mb-1.5">// MACHINE</span>
          <select
            value={machineFilter ?? ''}
            onChange={(e) => onSelectMachine(e.target.value || null)}
            className="w-full bg-[var(--color-bg-0)] border border-[var(--color-line)] px-2 py-1 text-[11px] text-[color:var(--color-mid)] focus:outline-none focus:border-[color:var(--color-phos)]"
          >
            <option value="">All machines</option>
            {machines.map((m) => (
              <option key={m.machineId} value={m.machineId}>
                {m.hostname}{m.isSelf ? ' (this machine)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="px-3.5 py-2 border-b border-[var(--color-line)]">
        <span className="t-ghost text-[10px] tracking-[0.25em] block mb-1.5">// DEPENDENCIES</span>
        <div className="flex flex-wrap gap-1">
          {DEP_FILTERS.map(({ key, label, title }) => {
            const on = depFilter === key
            return (
              <button
                key={key}
                onClick={() => onDepFilter(key)}
                title={title}
                className="px-1.5 py-0.5 text-[10px] border transition-colors"
                style={{
                  borderColor: on ? 'var(--color-phos)' : 'var(--color-line)',
                  color: on ? 'var(--color-phos)' : 'var(--color-dim)',
                  background: on ? 'rgba(42,240,214,0.08)' : 'transparent',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto py-1.5">
        <div className="px-3.5 py-1">
          <span className="t-ghost text-[10px] tracking-[0.25em]">// REPOS</span>
        </div>
        <button
          onClick={() => onSelectRepo(null)}
          className="w-full flex items-center justify-between px-3.5 py-1 text-[11px] transition-colors hover:text-[color:var(--color-pale)]"
          style={{ color: activeRepo === null ? 'var(--color-mid)' : 'var(--color-dim)' }}
        >
          <span>{activeRepo === null ? '◉' : '○'} all repos</span>
          <span className="t-ghost text-[9px]">· {total}</span>
        </button>
        {repos.map(({ repo, count }) => {
          const on = activeRepo === repo
          const busy = forgetting === repo
          return (
            <div key={repo} className="group flex items-center">
              <button
                onClick={() => onSelectRepo(on ? null : repo)}
                className="flex-1 min-w-0 flex items-center justify-between px-3.5 py-1 text-[11px] transition-colors hover:text-[color:var(--color-pale)]"
                style={{ color: on ? 'var(--color-mid)' : 'var(--color-dim)' }}
                title={repoTooltip(repo, repoLocal.get(repo) !== false)}
              >
                <span className="truncate">{on ? '◉' : '○'} {repo || '(no repo)'}</span>
                <span className="t-ghost text-[9px] shrink-0 ml-1">· {count}</span>
              </button>
              <button
                onClick={() => onForgetRepo(repo, count)}
                disabled={busy}
                title={`Forget ${repo || '(no repo)'} (${count} symbols) — removes it from the graph and propagates the removal across machines`}
                className="shrink-0 px-2 py-1 text-[10px] text-red-500/60 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity disabled:opacity-100"
              >
                {busy ? '…' : 'forget'}
              </button>
            </div>
          )
        })}
        {repos.length === 0 && (
          <div className="px-3.5 t-dim text-[11px] italic">No repos.</div>
        )}
      </div>
    </aside>
  )
}

function SymbolRow({
  sym,
  active,
  onClick,
}: {
  sym: GraphSymbol
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-baseline gap-2 px-3 py-1.5 transition-colors hover:bg-[rgba(255,255,255,0.03)]"
      style={{
        borderLeft: active ? '2px solid var(--color-phos)' : '2px solid transparent',
        background: active ? 'rgba(42,240,214,0.06)' : 'transparent',
      }}
    >
      <span className="text-[9px] font-mono uppercase tracking-wider text-violet-400 shrink-0 w-16 truncate">
        {sym.symbolKind}
      </span>
      <span className="font-mono text-[12px] text-[color:var(--color-pale)] truncate flex-1 min-w-0">
        {sym.name}
      </span>
      {sym.centrality > 0 && (
        <span className="t-ghost text-[9px] shrink-0" title={`${sym.centrality} dependents`}>
          ←{sym.centrality}
        </span>
      )}
      {sym.groundTruthValid === false && (
        <span className="text-[9px] font-bold uppercase text-red-400 shrink-0">stale</span>
      )}
    </button>
  )
}

export function CodeView() {
  const [symbols, setSymbols] = useState<GraphSymbol[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeRepo, setActiveRepo] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [depFilter, setDepFilter] = useState<DepFilter>('all')
  const [outDegree, setOutDegree] = useState<Set<string>>(new Set())
  const [forgetting, setForgetting] = useState<string | null>(null)
  const machines = useStore((s) => s.machines)
  const machineFilter = useStore((s) => s.machineFilter)
  // Branch selector for the graph view: which branch's symbols to display.
  const [views, setViews] = useState<SymbolView[]>([])
  const [branchSel, setBranchSel] = useState<string | null>(null) // explicit pick (transient)
  const [resolvedBranch, setResolvedBranch] = useState<string | null>(null) // what the server showed
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null) // persisted pin

  // Seed machines list if not already populated (e.g. user hasn't visited Machines view).
  useEffect(() => {
    if (machines.length > 0) return
    void graphListMachines()
      .then((r) => useStore.setState({ machines: r.machines }))
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Load symbols + the symbol-graph edge list (edges give out-degree, which is
  // not on the symbol row; in-degree is the symbol's centrality). Both are
  // read-only GETs.
  const reload = () => {
    setLoading(true)
    const machine = machineFilter ?? undefined
    return Promise.all([graphListSymbols({ limit: 10000, machine }), graphSymbolGraph(undefined, machine)])
      .then(([list, graph]) => {
        setSymbols(list)
        setOutDegree(new Set(graph.edges.map((e) => e.from)))
        setLoading(false)
      })
      .catch((e) => {
        setError(String(e))
        setLoading(false)
      })
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const machine = machineFilter ?? undefined
    Promise.all([graphListSymbols({ limit: 10000, machine }), graphSymbolGraph(undefined, machine)])
      .then(([list, graph]) => {
        if (cancelled) return
        setSymbols(list)
        setOutDegree(new Set(graph.edges.map((e) => e.from)))
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [machineFilter])

  // Branch coordinates for the selector — refetched whenever symbols reload
  // (covers machine-filter changes and repo forgets). Machine-agnostic; the
  // per-repo derivation below filters by the active machine client-side.
  useEffect(() => {
    void graphSymbolViews().then(setViews).catch(() => {})
  }, [symbols])

  // On repo change: reset the transient pick + resolved branch, and load this
  // repo's persisted display-default (the right-click ★ pin).
  useEffect(() => {
    setBranchSel(null)
    setResolvedBranch(null)
    if (!activeRepo) {
      setDefaultBranch(null)
      return
    }
    let cancelled = false
    void graphGetDefaultBranch(activeRepo).then((b) => {
      if (!cancelled) setDefaultBranch(b)
    })
    return () => {
      cancelled = true
    }
  }, [activeRepo])

  // Branches the active repo has symbols on (counts summed, honoring the machine
  // filter), richest first — the selector's options.
  const branchOptions = useMemo<BranchOption[]>(() => {
    if (!activeRepo) return []
    const counts = new Map<string, number>()
    for (const v of views) {
      if (v.repo !== activeRepo) continue
      if (machineFilter && v.machine !== machineFilter) continue
      counts.set(v.branch, (counts.get(v.branch) ?? 0) + v.symbols)
    }
    return [...counts.entries()]
      .map(([branch, count]) => ({ branch, count }))
      .sort((a, b) => b.count - a.count || (a.branch < b.branch ? -1 : 1))
  }, [views, activeRepo, machineFilter])

  const handleSetDefault = (b: string) => {
    if (!activeRepo) return
    setDefaultBranch(b)
    setBranchSel(b) // apply immediately
    void graphSetDefaultBranch(activeRepo, b)
  }
  const handleClearDefault = () => {
    if (!activeRepo) return
    setDefaultBranch(null)
    setBranchSel(null) // revert to auto-resolution
    void graphSetDefaultBranch(activeRepo, null)
  }

  // Focus a specific symbol when arriving from the graph's "open in code" action.
  // Reveal it (clear filters, switch to its repo) and select it so the inspector
  // shows its signature + blast radius; then consume the focus so it fires once.
  const codeFocusId = useStore((s) => s.codeFocusId)
  const clearCodeFocus = useStore((s) => s.setCodeFocus)
  useEffect(() => {
    if (!codeFocusId) return
    const repo = codeFocusId.includes(':') ? codeFocusId.slice(0, codeFocusId.indexOf(':')) : ''
    setActiveRepo(repo || null)
    setQuery('')
    setDepFilter('all')
    setSelectedId(codeFocusId)
    clearCodeFocus(null)
  }, [codeFocusId, clearCodeFocus])

  const handleForgetRepo = async (repo: string, count: number) => {
    const label = repo || '(no repo)'
    if (
      !window.confirm(
        `Forget the entire "${label}" code graph?\n\n` +
          `This deletes ${count} symbol${count === 1 ? '' : 's'} and all their edges ` +
          `from the graph, and (if private-mind is enabled) propagates the removal to ` +
          `your other machines. The source repo is untouched — re-extracting rebuilds it.`,
      )
    )
      return
    setForgetting(repo)
    try {
      await graphForgetRepoSymbols(repo)
      if (activeRepo === repo) setActiveRepo(null)
      setSelectedId(null)
      await reload()
    } catch (e) {
      setError(String(e))
    } finally {
      setForgetting(null)
    }
  }

  // Per-repo counts (server-truth of the full set, independent of filters).
  const repoCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of symbols) map.set(s.repo, (map.get(s.repo) ?? 0) + 1)
    return Array.from(map.entries())
      .map(([repo, count]) => ({ repo, count }))
      .sort((a, b) => b.count - a.count)
  }, [symbols])

  // Per-repo local-vs-remote, by symbol lineage. Local = at least one symbol
  // stamped with this machine's id (or an empty pre-lineage stamp); remote =
  // symbols belong only to another machine adopted via private-mind.
  const repoLocal = useMemo(() => {
    const self = machines.find((m) => m.isSelf)?.machineId ?? ''
    const map = new Map<string, boolean>()
    for (const s of symbols) {
      const local = s.machine === '' || s.machine === self
      map.set(s.repo, (map.get(s.repo) ?? false) || local)
    }
    return map
  }, [symbols, machines])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return symbols.filter((s) => {
      if (activeRepo !== null && s.repo !== activeRepo) return false
      if (depFilter !== 'all') {
        const hasDependents = s.centrality > 0 // in-edges (who depends on it)
        const hasDependencies = outDegree.has(s.id) // out-edges (what it uses)
        if (depFilter === 'connected' && !(hasDependents || hasDependencies)) return false
        if (depFilter === 'dependents' && !hasDependents) return false
        if (depFilter === 'dependencies' && !hasDependencies) return false
        if (depFilter === 'isolated' && (hasDependents || hasDependencies)) return false
      }
      if (!q) return true
      return (
        s.name.toLowerCase().includes(q) ||
        s.file.toLowerCase().includes(q) ||
        s.symbolKind.toLowerCase().includes(q)
      )
    })
  }, [symbols, activeRepo, query, depFilter, outDegree])

  // Group the filtered set by repo for the list pane.
  const grouped = useMemo(() => {
    const map = new Map<string, GraphSymbol[]>()
    for (const s of filtered) {
      const arr = map.get(s.repo) ?? []
      arr.push(s)
      map.set(s.repo, arr)
    }
    return Array.from(map.entries())
      .map(([repo, syms]) => ({ repo, syms }))
      .sort((a, b) => b.syms.length - a.syms.length)
  }, [filtered])

  const selected = useMemo(
    () => filtered.find((s) => s.id === selectedId) ?? symbols.find((s) => s.id === selectedId) ?? null,
    [filtered, symbols, selectedId],
  )

  return (
    <>
      <FilterSidebar
        repos={repoCounts}
        repoLocal={repoLocal}
        activeRepo={activeRepo}
        onSelectRepo={setActiveRepo}
        query={query}
        onQuery={setQuery}
        total={symbols.length}
        depFilter={depFilter}
        onDepFilter={setDepFilter}
        onForgetRepo={handleForgetRepo}
        forgetting={forgetting}
        machines={machines}
        machineFilter={machineFilter}
        onSelectMachine={(id) => useStore.setState({ machineFilter: id })}
      />

      {/* List pane */}
      <div
        className="shrink-0 border-r border-[var(--color-line)] flex flex-col overflow-hidden"
        style={{ width: 'var(--pane-wide, 22rem)', background: 'var(--color-bg-0)' }}
      >
        <div className="px-3.5 py-2 border-b border-[var(--color-line)] shrink-0 flex items-center justify-between">
          <span className="t-ghost text-[10px] tracking-[0.25em]">// SYMBOLS</span>
          <span className="t-ghost text-[9px] font-mono">{filtered.length}</span>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {loading && <div className="px-3.5 py-3 t-dim text-[11px]"><span className="caret">loading symbols</span></div>}
          {error && <div className="px-3.5 py-3 text-red-400 text-[11px]">{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="px-3.5 py-3 t-dim text-[11px] italic">No symbols match.</div>
          )}
          {grouped.map(({ repo, syms }) => (
            <div key={repo}>
              <div className="px-3 py-1 bg-[var(--color-bg-1)] border-y border-[var(--color-line)] sticky top-0 z-[1] flex items-center justify-between">
                <span
                  className="t-ghost text-[9px] tracking-[0.2em] uppercase truncate"
                  title={repoTooltip(repo, repoLocal.get(repo) !== false)}
                >
                  {repo || '(no repo)'}
                </span>
                <span className="t-ghost text-[9px] font-mono">{syms.length}</span>
              </div>
              {syms.map((s) => (
                <SymbolRow
                  key={s.id}
                  sym={s}
                  active={s.id === selectedId}
                  onClick={() => setSelectedId(s.id === selectedId ? null : s.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Inspector (a symbol is selected) */}
      {selected ? (
        <div className="flex-1 min-w-0 overflow-auto" style={{ background: 'var(--color-bg-0)' }}>
          <SymbolInspector
            value={toCodeSymbol(selected)}
            onChange={() => {}}
            ctx={{ knownAgents: [], knownCommands: [] }}
          />
        </div>
      ) : (
        /* Graph (no selection): branch selector above, graph fills the rest */
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden" style={{ background: 'var(--color-bg-0)' }}>
          <CodeBranchBar
            repo={activeRepo ?? ''}
            branches={branchOptions}
            effective={branchSel ?? resolvedBranch ?? defaultBranch ?? ''}
            defaultBranch={defaultBranch}
            onView={setBranchSel}
            onSetDefault={handleSetDefault}
            onClearDefault={handleClearDefault}
          />
          <div className="flex-1 min-h-0">
            <CodeGraphView
              repo={activeRepo}
              branch={branchSel ?? undefined}
              machine={machineFilter ?? undefined}
              onSelect={(id) => setSelectedId(id)}
              onBranchResolved={setResolvedBranch}
            />
          </div>
        </div>
      )}
    </>
  )
}
