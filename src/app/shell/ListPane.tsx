import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '@/app/store'
import { descriptorFor } from '@/ui-descriptors'
import { ColorDot, List, openContextMenu, prompt, type ContextMenuItem } from '@/ui-primitives'
import { kindSpecs, type Entity } from '@/ontology'
import { prefetchConversation } from '@/adapters'
import { buildScopeTargets } from './targets'

export function ListPane() {
  const kind = useStore((s) => s.kind)
  const scope = useStore((s) => s.scope)
  const projects = useStore((s) => s.projects)
  const entities = useStore((s) => (s.entities as any)[kind] as Entity<any>[])
  const selected = useStore((s) => s.selectedId)
  const setSelected = useStore((s) => s.setSelected)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const createNew = useStore((s) => s.createNew)
  const deleteExisting = useStore((s) => s.deleteExisting)
  const copyToScope = useStore((s) => s.copyToScope)
  const moveToScope = useStore((s) => s.moveToScope)
  const createIn = useStore((s) => s.createIn)
  const home = useStore((s) => s.home)
  const globalEntityIds = useStore((s) => s.globalEntityIds)

  const descriptor = descriptorFor(kind)
  const spec = kindSpecs[kind]

  const tabs = descriptor.tabs ?? []
  const activeTabStore = useStore((s) => s.activeTab)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const activeTabId = tabs.length > 0 ? (activeTabStore[kind] ?? tabs[0]!.id) : null
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  const items = useMemo(() => {
    const q = search.toLowerCase().trim()
    let filtered = entities
    if (activeTab) filtered = filtered.filter((e) => activeTab.predicate(e.value))
    if (q) filtered = filtered.filter((e) => spec.searchText(e.value).includes(q))
    const globalIds = globalEntityIds[kind]
    return filtered.map((e) => {
      const overridesGlobal = scope.type === 'project' && globalIds?.has(e.id)
      return {
        id: e.id,
        label: descriptor.listLabel(e.value),
        sublabel: descriptor.listSublabel?.(e.value),
        badge: e.dirty
          ? <ColorDot color="orange" title="Unsaved changes" />
          : overridesGlobal
            ? <OverrideBadge />
            : undefined,
        error: !!e.error,
      }
    })
  }, [entities, search, descriptor, spec, activeTab])

  // Predictive prefetch: when the user hovers on a conversation item for a
  // beat, start parsing it in the background so the click feels instant.
  // 120ms distinguishes "mouse resting here" from "flew past".
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
  }, [])
  const handleHover = useMemo<((id: string) => void) | undefined>(() => {
    if (kind !== 'conversation') return undefined
    return (id: string) => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = setTimeout(() => {
        const entity = entities.find((e) => e.id === id)
        if (entity?.path) prefetchConversation(entity.path)
      }, 120)
    }
  }, [kind, entities])

  const handleNew = async () => {
    const input = await prompt(descriptor.newLabel, {
      placeholder: descriptor.newPromptLabel,
    })
    if (!input) return
    await createNew(kind, input, descriptor.newDefault(input))
  }

  const contextItemsFor = (entityId: string): ContextMenuItem[] => {
    const entity = entities.find((e) => e.id === entityId)
    if (!entity) return []
    const entitySpec = kindSpecs[entity.kind]
    const entityReadOnly = entitySpec.readOnly ?? false
    const canScopeMove = !entityReadOnly || (entitySpec.allowScopeMove ?? false)
    const entityDescriptor = descriptorFor(entity.kind)
    const canDelete = !entityReadOnly && (entityDescriptor.canDelete ? entityDescriptor.canDelete(entity.value) : true)
    const targets = canScopeMove ? buildScopeTargets(entity, projects) : []
    const menu: ContextMenuItem[] = []

    const custom =
      descriptor.customActions?.(entity, {
        scope,
        projects,
        home,
        createIn,
        remove: deleteExisting,
      }) ?? []
    menu.push(...custom)

    if (targets.length > 0) {
      const promotes = targets.filter((t) => t.relation === 'promote')
      const demotes = targets.filter((t) => t.relation === 'demote')
      const laterals = targets.filter((t) => t.relation === 'lateral')

      // Promote: move up to parent (single target — always direct parent)
      for (const t of promotes) {
        menu.push({
          label: `↑ Promote to ${t.name}`,
          onSelect: () => moveToScope(entity, t.scope),
        })
      }

      // Demote: copy down to child scopes
      if (demotes.length === 1) {
        menu.push({
          label: `↓ Demote to ${demotes[0]!.name}`,
          onSelect: () => copyToScope(entity, demotes[0]!.scope),
        })
      } else if (demotes.length > 1) {
        menu.push({
          label: '↓ Demote to…',
          submenu: demotes.map((t) => ({
            label: t.name,
            onSelect: () => copyToScope(entity, t.scope),
          })),
        })
      }

      // Lateral copy/move
      if (laterals.length > 0) {
        menu.push({
          label: 'Copy to…',
          submenu: laterals.map((t) => ({
            label: t.name,
            onSelect: () => copyToScope(entity, t.scope),
          })),
        })
        menu.push({
          label: 'Move to…',
          submenu: laterals.map((t) => ({
            label: t.name,
            onSelect: () => moveToScope(entity, t.scope),
          })),
        })
      }
    }
    if (canDelete) {
      menu.push({
        label: 'Delete',
        destructive: true,
        onSelect: () => {
          if (confirm(`Delete ${descriptor.listLabel(entity.value)}?`))
            deleteExisting(entity)
        },
      })
    }
    return menu
  }

  return (
    <section
      className="shrink-0 border-r border-[var(--color-line)] flex flex-col"
      style={{ width: 'var(--pane-wide)', background: 'var(--color-bg-1)' }}
    >
      <header className="px-3.5 py-2.5 border-b border-[var(--color-line)] flex items-center gap-2">
        <div className="flex-1 relative flex items-center border border-[var(--color-line)]">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${spec.pluralLabel.toLowerCase()}…`}
            className="w-full bg-transparent outline-none px-2 py-1 pr-6 text-[11px] t-mid placeholder:text-[color:var(--color-ghost)] focus:border-[color:var(--color-amber-dim)]"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              title="Clear search"
              className="absolute right-1 w-4 h-4 flex items-center justify-center t-ghost hover:text-[color:var(--color-mid)]"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="stroke-current" strokeWidth="1.5" strokeLinecap="round">
                <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" />
              </svg>
            </button>
          )}
        </div>
        {!(spec.readOnly ?? false) && !(spec.noCreate ?? false) && (
          <button onClick={handleNew} className="btn text-[11px]" title={descriptor.newLabel}>
            + New
          </button>
        )}
      </header>
      {tabs.length > 0 && (
        <div className="flex border-b border-[var(--color-line)] px-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(kind, t.id)}
              className="text-[11px] px-3 py-1.5 transition-colors"
              style={{
                color: activeTabId === t.id ? 'var(--color-pale)' : 'var(--color-dim)',
                borderBottom: activeTabId === t.id ? '2px solid var(--color-phos)' : '2px solid transparent',
                marginBottom: activeTabId === t.id ? -1 : 0,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        <List
          items={items}
          selectedId={selected}
          onSelect={setSelected}
          onHover={handleHover}
          onContextMenu={(id, e) => {
            setSelected(id)
            openContextMenu(e, contextItemsFor(id))
          }}
          empty={`No ${spec.pluralLabel.toLowerCase()} in this scope.`}
        />
      </div>
    </section>
  )
}

function OverrideBadge() {
  return (
    <span
      title="This entity overrides a global config with the same name"
      className="text-[9px] px-1 py-0.5 rounded bg-blue-900/50 text-blue-400 border border-blue-800/60 font-mono leading-none"
    >
      ↑ global
    </span>
  )
}

