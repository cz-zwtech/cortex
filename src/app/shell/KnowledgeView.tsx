import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useStore } from '@/app/store'
import { graphListRecent, graphListMachines } from '@/adapters/graph'
import type { GraphLink } from '@/adapters/graph'
import { openVaultImportDialog } from '@/ui-primitives'

// Tone for kind labels (matches Cortex palette: phos / amber / rose / cyan / dim)
const KIND_TONE: Record<string, string> = {
  memory: 'var(--color-phos)',
  feedback: 'var(--color-warn)',
  reference: 'var(--color-cyan)',
  concept: 'var(--color-phos)',
  technology: 'var(--color-cyan)',
  pattern: 'var(--color-amber)',
  decision: 'var(--color-rose)',
  project: 'var(--color-rose)',
  // Consolidated beliefs + the kinds that used to fall through to dim.
  observation: 'var(--color-phos)',
  topic: 'var(--color-cyan)',
  workflow: 'var(--color-amber)',
  error: 'var(--color-rose)',
  note: 'var(--color-mid)',
  session: 'var(--color-dim)',
  agent: 'var(--color-warn)',
  tool: 'var(--color-dim)',
  file: 'var(--color-dim)',
}
const toneFor = (kind: string) => KIND_TONE[kind] ?? 'var(--color-dim)'

// ── Filter sidebar (tags + kind facets) ─────────────────────────────────────
// The old scope ("Context") list was removed — it grew unboundedly with every
// project/vault scope. The search bar covers scope lookup; tags + kind remain
// as quick facet filters.

function ContextSidebar({
  onSelectScope,
  tagCounts,
  activeTag,
  onSelectTag,
  kindCounts,
  hiddenKinds,
  onToggleKind,
  onImportVault,
  onSync,
  importing,
  machines,
  machineFilter,
  onSelectMachine,
}: {
  onSelectScope: (scope: string | null) => void
  tagCounts: { tag: string; count: number }[]
  activeTag: string | null
  onSelectTag: (tag: string | null) => void
  kindCounts: { kind: string; count: number }[]
  hiddenKinds: Set<string>
  onToggleKind: (kind: string) => void
  onImportVault: () => void
  onSync: () => void
  importing: boolean
  machines: import('@/adapters/graph').MachineInfo[]
  machineFilter: string | null
  onSelectMachine: (machineId: string | null) => void
}) {
  return (
    <aside
      className="shrink-0 border-r border-[var(--color-line)] flex flex-col overflow-hidden"
      style={{ width: 'var(--pane-narrow)', background: 'var(--color-bg-1)' }}
    >
      <div className="px-3.5 pt-2.5 pb-2 border-b border-[var(--color-line)] flex items-center gap-1.5 shrink-0">
        <span className="t-ghost text-[10px] tracking-[0.25em] flex-1 whitespace-nowrap">// FILTERS</span>
        <button
          onClick={onImportVault}
          disabled={importing}
          className="t-ghost hover:text-[color:var(--color-amber)] disabled:opacity-40 px-1"
          title="Import a directory of markdown into the graph"
          aria-label="Import vault"
        >
          <ImportIcon />
        </button>
        <button
          onClick={onSync}
          className="t-ghost hover:text-[color:var(--color-amber)] px-1"
          title="Sync memory files"
          aria-label="Sync"
        >
          ↻
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {machines.length > 0 && (
          <div className="border-t border-[var(--color-line)] px-3.5 py-2.5">
            <span className="t-ghost text-[10px] tracking-[0.25em]">// MACHINE</span>
            <select
              value={machineFilter ?? ''}
              onChange={(e) => onSelectMachine(e.target.value || null)}
              className="mt-1.5 w-full bg-[var(--color-bg-0)] border border-[var(--color-line)] px-2 py-1 text-[11px] text-[color:var(--color-mid)] focus:outline-none focus:border-[color:var(--color-phos)]"
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

        {tagCounts.length > 0 && (
          <div className="border-t border-[var(--color-line)] py-1.5">
            <div className="px-3.5 py-1">
              <span className="t-ghost text-[10px] tracking-[0.25em]">// TAGS</span>
            </div>
            {tagCounts.map(({ tag, count }) => (
              <ContextRow
                key={tag}
                label={tag}
                count={count}
                active={activeTag === tag}
                onClick={() => {
                  onSelectTag(activeTag === tag ? null : tag)
                  onSelectScope(null)
                }}
                symbol="#"
              />
            ))}
          </div>
        )}

        {kindCounts.length > 0 && (
          <div className="border-t border-[var(--color-line)] px-3.5 py-2.5">
            <span className="t-ghost text-[10px] tracking-[0.25em]">// KIND</span>
            <div className="mt-1.5">
              {kindCounts.map(({ kind, count }) => {
                const hidden = hiddenKinds.has(kind)
                return (
                  <button
                    key={kind}
                    onClick={() => onToggleKind(kind)}
                    className="w-full flex items-center justify-between text-[11px] py-1 transition-colors hover:text-[color:var(--color-pale)]"
                    style={{ color: hidden ? 'var(--color-dim)' : 'var(--color-mid)' }}
                  >
                    <span>
                      <span style={{ color: hidden ? 'var(--color-ghost)' : toneFor(kind), marginRight: 6 }}>
                        {hidden ? '○' : '◉'}
                      </span>
                      {kind}
                    </span>
                    <span className="t-ghost text-[9px]">· {count}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}

function ContextRow({
  label,
  count,
  active,
  onClick,
  symbol,
  tags,
  onEditTags,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
  symbol: string
  /** Optional — tags display under the row when present. */
  tags?: string[]
  /** Optional — when supplied, a `#` button appears on hover for tag editing. */
  onEditTags?: (anchor: DOMRect) => void
}) {
  const tagBtnRef = useRef<HTMLButtonElement | null>(null)
  return (
    <div
      className="group relative w-full flex items-center gap-1 transition-colors hover:bg-[rgba(176,112,255,0.06)]"
      style={{
        borderLeft: active ? '2px solid var(--color-phos)' : '2px solid transparent',
        background: active ? 'linear-gradient(90deg, rgba(176,112,255,0.14), transparent 70%)' : undefined,
      }}
    >
      <button
        onClick={onClick}
        title={label}
        className="flex-1 min-w-0 text-left flex items-center gap-2"
        style={{
          padding: '6px 14px',
          color: active ? 'var(--color-pale)' : 'var(--color-mid)',
        }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-[12px] truncate">
            {symbol} {label}
          </div>
          {tags && tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-0.5">
              {tags.map((t) => (
                <span key={t} className="tag" style={{ fontSize: 9 }}>
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="t-ghost text-[10px] shrink-0 tabular-nums">· {count}</span>
      </button>
      {onEditTags && (
        <button
          ref={tagBtnRef}
          onClick={(e) => {
            e.stopPropagation()
            const r = tagBtnRef.current?.getBoundingClientRect()
            if (r) onEditTags(r)
          }}
          className="opacity-0 group-hover:opacity-100 t-ghost hover:text-[color:var(--color-amber)] px-1.5 text-xs transition-colors"
          title="Edit tags"
        >
          #
        </button>
      )}
    </div>
  )
}

// ── Concept list ─────────────────────────────────────────────────────────────

function ConceptList({
  results,
  searching,
  query,
  selectedId,
  onSelect,
  onQueryChange,
  sortBySync,
  onToggleSort,
  lastSync,
}: {
  results: ReturnType<typeof useStore.getState>['graphResults']
  searching: boolean
  query: string
  selectedId: string | null
  onSelect: (id: string) => void
  onQueryChange: (q: string) => void
  sortBySync: boolean
  onToggleSort: () => void
  lastSync: number | null
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <section
      className="shrink-0 border-r border-[var(--color-line)] flex flex-col"
      style={{ width: 'var(--pane-mid)', background: 'var(--color-bg-1)' }}
    >
      <div className="px-3.5 pt-2.5 pb-2 border-b border-[var(--color-line)]">
        <div className="flex items-center gap-2 mb-2">
          <span className="t-ghost text-[10px] tracking-[0.25em] flex-1">// KNOWLEDGE GRAPH</span>
          {lastSync && (
            <button
              onClick={onToggleSort}
              title={sortBySync ? 'Default order' : 'Sort by sync time (newest in graph first)'}
              className="text-[9px] font-mono transition-colors"
              style={{ color: sortBySync ? 'var(--color-amber)' : 'var(--color-ghost)' }}
            >
              {sortBySync ? '↓ ' : ''}synced {formatRelative(lastSync)}
            </button>
          )}
        </div>
        <div className="flex items-center border border-[var(--color-line)]">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search knowledge graph…"
            className="flex-1 bg-transparent outline-none px-2 py-1 text-[11px] t-mid placeholder:text-[color:var(--color-ghost)]"
          />
          {searching && <Spinner />}
          {query && !searching && (
            <button onClick={() => onQueryChange('')} className="t-ghost hover:text-[color:var(--color-mid)] px-2 leading-none">
              ×
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {!searching && results.length === 0 && (
          <div className="px-4 py-5 t-dim text-[11px] italic">
            {query ? 'No matches.' : 'No entries. Click ↻ to sync.'}
          </div>
        )}
        {results.map((entry) => {
          const on = entry.id === selectedId
          return (
            <button
              key={entry.id}
              onClick={() => onSelect(entry.id)}
              className="w-full text-left transition-colors hover:bg-[rgba(176,112,255,0.06)]"
              style={{
                padding: '8px 14px',
                borderBottom: '1px solid var(--color-line)',
                borderLeft: on ? '2px solid var(--color-phos)' : '2px solid transparent',
                background: on ? 'linear-gradient(90deg, rgba(176,112,255,0.14), transparent 70%)' : undefined,
              }}
            >
              <div
                className="text-[9px] tracking-[0.1em] uppercase"
                style={{ color: toneFor(entry.kind) }}
              >
                {entry.kind}
              </div>
              <div
                className="text-[11px] mt-0.5 truncate"
                style={{ color: on ? 'var(--color-pale)' : 'var(--color-mid)' }}
              >
                {entry.name}
              </div>
              {entry.description && (
                <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--color-ghost)' }}>
                  {entry.description}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}

// ── Detail pane (markdown body + backlinks rail) ─────────────────────────────

function ConceptDetail() {
  const entry = useStore((s) => s.selectedEntry)
  const loading = useStore((s) => s.graphEntryLoading)
  const setSelected = useStore((s) => s.setSelectedEntryId)
  const queue = useStore((s) => s.sharedQueue)
  const queueForShared = useStore((s) => s.queueForShared)

  if (loading) {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center">
        <Spinner />
      </div>
    )
  }

  if (!entry) {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center" style={{ color: 'var(--color-dim)' }}>
        <span className="text-[12px]">Select a concept to view its detail.</span>
      </div>
    )
  }

  // Graph entries always share as kind:'memory' — the shared-mind only
  // distinguishes content type (memory) from artifact files (skill, agent
  // etc.). The original graph kind is preserved in the memory's
  // frontmatter via the source-render path.
  const queueId = `memory:graph:${entry.id}`
  const queued = queue.some((q) => q.id === queueId)
  const handleShare = () => {
    void queueForShared({
      id: queueId,
      kind: 'memory',
      title: entry.name,
      description: entry.description || undefined,
      payload: {
        body: entry.content,
        // Preserve provenance so the shared memory's frontmatter shows
        // where this came from in the graph.
        graphKind: entry.kind,
        graphScope: entry.scope,
      },
      sourcePath: entry.source,
      queuedAt: Date.now(),
    })
  }

  return (
    <section className="flex-1 min-w-0 flex flex-col">
      {/* Header */}
      <header className="px-5 py-3.5 border-b border-[var(--color-line)] shrink-0">
        <div className="flex items-center gap-2">
          <span className="t-ghost text-[10px] tracking-[0.25em] flex-1">// CONCEPT</span>
          <button
            onClick={handleShare}
            className="btn text-[11px]"
            style={
              queued
                ? { color: 'var(--color-amber)', borderColor: 'var(--color-amber-dim)' }
                : undefined
            }
            title={
              queued
                ? 'In publish queue — click to re-queue with current values'
                : 'Add to shared-mind publish queue as a memory'
            }
          >
            {queued ? 'queued ↑' : 'share →'}
          </button>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span
            className="text-[9px] tracking-[0.1em] uppercase"
            style={{ color: toneFor(entry.kind) }}
          >
            {entry.kind}
          </span>
          <h1 className="t-hi text-[14px] flex-1 min-w-0 truncate">{entry.name}</h1>
        </div>
        {entry.description && (
          <p className="t-mid text-[11px] mt-1.5 leading-relaxed">{entry.description}</p>
        )}
      </header>

      {/* Body + backlinks rail */}
      <div className="flex-1 min-h-0 flex">
        <div
          className="flex-1 min-w-0 overflow-auto px-5 py-4 text-[12px] leading-[1.7] t-mid"
        >
          {entry.content ? (
            <div className="prose prose-sm prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown>
            </div>
          ) : (
            <div className="t-dim text-[11px] italic">No content for this entry.</div>
          )}
        </div>
        <aside
          className="shrink-0 border-l border-[var(--color-line)] overflow-auto p-3.5"
          style={{ width: 'var(--pane-narrow)', background: 'var(--color-bg-1)' }}
        >
          {entry.links.length > 0 && (
            <>
              <div className="t-ghost text-[10px] tracking-[0.2em]">// LINKS TO · {entry.links.length}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {entry.links.map((link) => (
                  <LinkChip key={link.id} link={link} onClick={() => setSelected(link.id)} />
                ))}
              </div>
            </>
          )}
          {entry.backlinks.length > 0 && (
            <>
              <div className="t-ghost text-[10px] tracking-[0.2em] mt-4">// BACKLINKS · {entry.backlinks.length}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {entry.backlinks.map((link) => (
                  <LinkChip key={link.id} link={link} onClick={() => setSelected(link.id)} />
                ))}
              </div>
            </>
          )}
          {entry.links.length === 0 && entry.backlinks.length === 0 && (
            <div className="t-dim text-[10px] italic">No links.</div>
          )}
        </aside>
      </div>
    </section>
  )
}

function LinkChip({ link, onClick }: { link: GraphLink; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="tag inline-flex items-center gap-1.5 hover:!border-[color:var(--color-amber-dim)] hover:!text-[color:var(--color-amber)]"
      style={{ fontSize: 9, maxWidth: '100%' }}
      title={link.name}
    >
      <span style={{ color: toneFor(link.kind) }}>●</span>
      <span className="truncate">{link.name}</span>
    </button>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  const hrs = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hrs < 24) return `${hrs}h ago`
  return `${days}d ago`
}

function ImportIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      style={{ color: 'var(--color-dim)' }}
    >
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
    </svg>
  )
}

// ── Main view ────────────────────────────────────────────────────────────────

export function KnowledgeView() {
  const results = useStore((s) => s.graphResults)
  const searching = useStore((s) => s.graphSearching)
  const query = useStore((s) => s.graphQuery)
  const selectedId = useStore((s) => s.selectedEntryId)
  const setSelected = useStore((s) => s.setSelectedEntryId)
  const setGraphQuery = useStore((s) => s.setGraphQuery)
  const stats = useStore((s) => s.graphStats)
  const triggerSync = useStore((s) => s.triggerGraphSync)

  const projectTags = useStore((s) => s.projectTags)
  const scopeTags = useStore((s) => s.scopeTags)
  const hiddenTags = useStore((s) => s.hiddenTags)
  const projects = useStore((s) => s.projects)
  const graphScopes = useStore((s) => s.graphScopes)
  const graphKinds = useStore((s) => s.graphKinds)
  const machines = useStore((s) => s.machines)
  const machineFilter = useStore((s) => s.machineFilter)

  const importing = false // dialog manages its own state now
  const [sortBySync, setSortBySync] = useState(false)
  const [activeScope, setActiveScope] = useState<string | null>(null)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set())

  // Seed machines list if not already populated (e.g. user hasn't visited Machines view).
  useEffect(() => {
    if (machines.length > 0) return
    void graphListMachines()
      .then((r) => useStore.setState({ machines: r.machines }))
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Apply or clear sort-by-sync
  useEffect(() => {
    if (!sortBySync) return
    useStore.setState({ graphSearching: true })
    void graphListRecent(200, { sort: 'synced', ...(machineFilter ? { machine: machineFilter } : {}) })
      .then((entries) => useStore.setState({ graphResults: entries, graphSearching: false }))
      .catch(() => useStore.setState({ graphSearching: false }))
  }, [sortBySync, machineFilter])

  // Re-fetch results when scope/tag/machine filter changes. For scope we filter
  // server-side (precise). For tag (which lives on the project, not the entry)
  // we pull a wider limit and then filter client-side in `filteredResults`.
  useEffect(() => {
    if (sortBySync) return
    if (query.trim()) return // search dominates; let setGraphQuery handle results
    if (!activeScope && !activeTag && !machineFilter) return
    useStore.setState({ graphSearching: true })
    const opts: Parameters<typeof graphListRecent>[1] = activeScope ? { scope: activeScope } : {}
    if (machineFilter) opts.machine = machineFilter
    const limit = activeTag ? 1000 : 500
    void graphListRecent(limit, opts)
      .then((entries) => useStore.setState({ graphResults: entries, graphSearching: false }))
      .catch(() => useStore.setState({ graphSearching: false }))
  }, [activeScope, activeTag, machineFilter, sortBySync, query])

  // Project scopes use Claude's encoded path (`-mnt-e-Repos-sokn`) while the
  // store's `projectTags` is keyed by `Project.id` (slashes/colons stripped).
  // Build a lookup from encoded-path → projectId so we can resolve tags.
  const projectIdByEncodedPath = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of projects) {
      const encoded = p.path.replace(/[\/\\:]/g, '-')
      map.set(encoded, p.id)
    }
    return map
  }, [projects])

  // Resolve the tags for a graph scope. Project scopes pull from `projectTags`
  // (keyed by Project.id). Vault / user / other scopes use `scopeTags` keyed
  // by the raw scope string. Any tags in both sources get unioned.
  const tagsForScope = (scope: string): string[] => {
    const direct = scopeTags[scope] ?? []
    if (!scope.startsWith('project:')) return direct
    const encoded = scope.slice('project:'.length)
    const projectId = projectIdByEncodedPath.get(encoded)
    const fromProject = projectId ? (projectTags[projectId] ?? []) : []
    if (direct.length === 0) return fromProject
    if (fromProject.length === 0) return direct
    return Array.from(new Set([...fromProject, ...direct]))
  }

  // Hide scopes whose project is hidden by the global tag filter (SelectionBar).
  // A scope is hidden if its project carries ONLY tags that are all hidden.
  // Scopes with no tags (vault, user, untagged projects) are always visible.
  const isScopeHidden = (scope: string): boolean => {
    const tags = tagsForScope(scope)
    if (tags.length === 0) return false
    return tags.every((t) => hiddenTags.has(t))
  }

  // Scope and kind lists come from server-truth aggregations so they reflect

  // Tags are still derived from in-memory project metadata since they're not
  // an entry property — they live on projects in the store.
  const tagCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const v of graphScopes) {
      for (const t of tagsForScope(v.scope)) {
        // Don't count an entry under a tag that's globally hidden.
        if (hiddenTags.has(t)) continue
        map.set(t, (map.get(t) ?? 0) + v.count)
      }
    }
    return Array.from(map.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphScopes, projectTags, scopeTags, hiddenTags])

  // file/tool nodes are MENTIONS_* traversal stubs (no content) — graph
  // plumbing for "which memories touch this file/tool", not browsable
  // memories. Keep them out of the kind facet + the results list. (session is
  // left in — it can carry real recap content.)
  const STUB_KINDS = new Set(['file', 'tool'])
  const kindCounts = graphKinds.filter((k) => !STUB_KINDS.has(k.kind))

  const filteredResults = useMemo(() => {
    return results.filter((r) => {
      if (isScopeHidden(r.scope)) return false
      if (activeScope && r.scope !== activeScope) return false
      if (activeTag && !tagsForScope(r.scope).includes(activeTag)) return false
      if (hiddenKinds.has(r.kind)) return false
      if (STUB_KINDS.has(r.kind)) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, activeScope, activeTag, hiddenKinds, projectTags, scopeTags, hiddenTags])

  const handleImportVault = () => {
    void openVaultImportDialog()
  }

  const toggleKind = (kind: string) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  return (
    <>
      <ContextSidebar
        onSelectScope={setActiveScope}
        tagCounts={tagCounts}
        activeTag={activeTag}
        onSelectTag={setActiveTag}
        kindCounts={kindCounts}
        hiddenKinds={hiddenKinds}
        onToggleKind={toggleKind}
        onImportVault={handleImportVault}
        onSync={() => void triggerSync()}
        importing={importing}
        machines={machines}
        machineFilter={machineFilter}
        onSelectMachine={(id) => useStore.setState({ machineFilter: id })}
      />
      <ConceptList
        results={filteredResults}
        searching={searching}
        query={query}
        selectedId={selectedId}
        onSelect={setSelected}
        onQueryChange={(q) => {
          setSortBySync(false)
          setGraphQuery(q)
        }}
        sortBySync={sortBySync}
        onToggleSort={() => {
          const next = !sortBySync
          setSortBySync(next)
          if (!next) setGraphQuery('')
        }}
        lastSync={stats?.lastSync ?? null}
      />
      <ConceptDetail />
    </>
  )
}
