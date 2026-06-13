import { create } from 'zustand'
import {
  fs,
  readByKind,
  readConversations,
  enrichConversation,
  writeEntity as adapterWrite,
  createEntity as adapterCreate,
  deleteEntity as adapterDelete,
  isRecentSelfWrite,
  kindsForPath,
  type ConversationEnrichJob,
  type Location,
  type WriteContext,
} from '@/adapters'
import {
  loadProjects,
  addManualProject,
  removeManualProject,
  resolveLocation,
  watchTargetsFor,
  loadUiState,
  saveUiState,
  scopeFromKey,
  loadSettings,
  saveSettings,
  initTokenCache,
  initPersistentCaches,
  invalidateConversation,
  invalidateToolResults,
  invalidatePath,
} from '@/registry'
import {
  allKinds,
  allKindsForScope,
  kindSupportsScope,
  defaultSettings,
  type AnyEntity,
  type Entity,
  type Kind,
  type Project,
  type Scope,
  type Settings,
  scopeEq,
  scopeKey,
} from '@/ontology'
import { buildReferenceGraph, type Reference } from '@/engine'
import {
  graphSearch,
  graphListRecent,
  graphGetEntry,
  graphStats,
  graphSync,
  graphAll,
  graphImportVault,
  graphListScopes,
  graphListKinds,
  graphListMachines,
  graphSymbolNeighborhood,
  type GraphEntry,
  type GraphEntryDetail,
  type GraphLink,
  type GraphSymbol,
  type GraphStats,
  type GraphNode,
  type GraphEdge,
  type MachineInfo,
} from '@/adapters/graph'
import {
  listSessions as fetchSessionList,
  fetchSessionRange,
  subscribeSessions,
  sessionKey,
  type SessionMeta,
  type ParsedLine,
} from '@/adapters/sessions'
import {
  sharedStatus as fetchSharedStatus,
  sharedQueueAdd,
  sharedQueueRemove,
  sharedQueueUpdate,
  sharedPublish,
  sharedSync,
  sharedSetRemote,
  sharedSetManifest,
  type SharedQueueItem,
  type SharedStatus,
  type SharedManifest,
  type PublishResult,
  type SyncResult,
} from '@/adapters/sharedMind'

interface EntitiesByKind {
  claudemd: Entity<any>[]
  memory: Entity<any>[]
  agent: Entity<any>[]
  command: Entity<any>[]
  skill: Entity<any>[]
  rule: Entity<any>[]
  hook: Entity<any>[]
  permission: Entity<any>[]
  mcp: Entity<any>[]
  plugin: Entity<any>[]
  marketplace: Entity<any>[]
  conversation: Entity<any>[]
  symbol: Entity<any>[]
}

const emptyBuckets = (): EntitiesByKind => ({
  claudemd: [],
  memory: [],
  agent: [],
  command: [],
  skill: [],
  rule: [],
  hook: [],
  permission: [],
  mcp: [],
  plugin: [],
  marketplace: [],
  conversation: [],
  symbol: [],
})

interface State {
  home: string
  ready: boolean
  projects: Project[]
  scope: Scope
  kind: Kind
  selectedId: string | null
  entities: EntitiesByKind
  refs: Reference[]
  search: string
  lastError: string | null
  selections: Record<string, string>
  settings: Settings
  /**
   * In-flight async operations keyed by `<op>:<target>` (e.g. `install:open-prose@prose`).
   * Reactive — UI subscribes to check whether a specific button should show a spinner
   * or be disabled. Set semantics so concurrent ops on different targets coexist.
   */
  pendingOps: Set<string>
  /**
   * Kinds whose read is still in flight for the current scope. The sidebar
   * watches this to swap the count for a spinner. `reload` marks all kinds
   * loading on entry and clears each as its read settles.
   */
  loadingKinds: Set<Kind>
  /** Active tab id per kind (kinds with `tabs` on their descriptor). */
  activeTab: Record<string, string>
  /** Tags per project, keyed by projectId. Persisted to ui-state, never written to .claude.json */
  projectTags: Record<string, string[]>
  /**
   * Tags per non-project graph scope (e.g. `vault:sokn`, `user`). Lets the
   * global tag-hide system extend beyond projects.
   */
  scopeTags: Record<string, string[]>
  /** Tags currently hidden from the sidebar scope list. */
  hiddenTags: Set<string>
  /** Active top-level view */
  view: 'home' | 'config' | 'knowledge' | 'graph' | 'code' | 'sessions' | 'machines' | 'profile'
  /** Personality profile surfacing switch (server env CKN_PROFILE). When false,
   *  the Profile nav item + view are hidden (facets are still tracked). */
  profileEnabled: boolean
  /** IconRail collapsed (icons only) vs expanded (icons + labels) */
  railExpanded: boolean
  /** Active session tab in Sessions view ('all' or '<projectDir>/<sessionId>'). */
  sessionTab: string
  /** All sessions returned by /api/sessions/list, keyed by sessionKey. */
  sessions: SessionMeta[]
  /** Per-session message buffer. Keyed by sessionKey. */
  sessionStreams: Record<string, ParsedLine[]>
  /** Per-session next-line cursor used for incremental fetches/appends. */
  sessionCursors: Record<string, number>
  /** Per-session loading flag (true while a /range fetch is in flight). */
  sessionLoading: Record<string, boolean>
  /** True once the WS subscription for sessions is wired. */
  sessionsWired: boolean
  /** Pinned tab keys. Persisted to cortex.ui.v1.pinnedSessions in localStorage. */
  pinnedSessions: string[]
  /** Hidden session keys. Persisted to ui-state.json. */
  hiddenSessionIds: Set<string>
  /** Per-session log direction: 'newest-top' (default) or 'oldest-top'. */
  sessionDirection: Record<string, 'newest-top' | 'oldest-top'>
  /** Per-session filter: 'loud' (default — everything) or 'quiet'. */
  sessionFilter: Record<string, 'loud' | 'quiet'>
  /** Whether the picker sheet is open. */
  sessionPickerOpen: boolean
  graphQuery: string
  graphResults: GraphEntry[]
  graphSearching: boolean
  selectedEntryId: string | null
  selectedEntry: GraphEntryDetail | null
  graphEntryLoading: boolean
  /** Symbol id the Code view should focus/select — set when jumping from the graph. */
  codeFocusId: string | null
  graphStats: GraphStats | null
  graphAllNodes: GraphNode[]
  graphAllEdges: GraphEdge[]
  graphAllLoading: boolean
  /** All scopes in the graph with entry counts — server-truth, independent of search/page limits. */
  graphScopes: { scope: string; count: number }[]
  /** All kinds in the graph with entry counts — server-truth. */
  graphKinds: { kind: string; count: number }[]
  /** Known machines from /api/machines — refreshed on entry to Machines view. */
  machines: MachineInfo[]
  /** Retired-node count from the last /api/machines fetch. Stored alongside
   *  `machines` so setView('machines') delivers both and the '· N retired'
   *  badge is visible on normal navigation (not just after an explicit load()). */
  machinesRetiredCount: number
  /** Active machine filter in the Machines view. null = all machines. */
  machineFilter: string | null
  /**
   * Recent graph entries by sync time — drives the Sessions view's right rail
   * (writes/5m sparkline + newest-memory list). Independent of `graphResults`
   * which reflects the Knowledge view's search query.
   */
  recentGraphActivity: GraphEntry[]
  /** Shared-mind state — queue + git status + manifest. Refreshed on entry. */
  sharedQueue: SharedQueueItem[]
  sharedStatus: SharedStatus | null
  sharedManifest: SharedManifest | null
  /** True while a publish or sync is in flight. UI uses to disable buttons. */
  sharedBusy: boolean
  /** Last publish/sync error or success message for the panel banner. */
  sharedLastMessage: string | null
  /**
   * Names of entities that exist at global (user) scope, keyed by kind.
   * Used to show "overrides global" badge when viewing a project scope.
   * Populated on bootstrap and after any reload.
   */
  globalEntityIds: Partial<Record<Kind, Set<string>>>
}

interface Actions {
  bootstrap: () => Promise<void>
  refreshProjects: () => Promise<void>
  setScope: (scope: Scope) => void
  setKind: (kind: Kind) => void
  setSelected: (id: string | null) => void
  setSearch: (s: string) => void
  reload: () => Promise<void>
  updateEntity: (entity: Entity<any>, next: any) => void
  createNew: (kind: Kind, input: string, value: any) => Promise<void>
  deleteExisting: (entity: Entity<any>) => Promise<void>
  copyToScope: (entity: Entity<any>, target: Scope) => Promise<void>
  moveToScope: (entity: Entity<any>, target: Scope) => Promise<void>
  createIn: (kind: Kind, value: any, target: Scope) => Promise<void>
  addProject: (path: string, name?: string) => Promise<void>
  removeProject: (project: Project) => Promise<void>
  updateProjectTags: (projectId: string, tags: string[]) => Promise<void>
  updateScopeTags: (scopeKey: string, tags: string[]) => Promise<void>
  toggleHiddenTag: (tag: string) => Promise<void>
  updateSettings: (next: Settings) => void
  setView: (view: 'home' | 'config' | 'knowledge' | 'graph' | 'code' | 'sessions' | 'machines' | 'profile') => void
  toggleRail: () => void
  setSessionTab: (tab: string) => void
  /** Refresh the full session list from the server. Cheap — the server walks the disk every call. */
  refreshSessions: () => Promise<void>
  /** Subscribe to WS events for session append/state if not already wired. Idempotent. */
  ensureSessionsWired: () => void
  /** Load the parsed message buffer for a session (full file). */
  loadSessionStream: (key: string) => Promise<void>
  /** Pin / unpin a session tab so it persists past the auto-pin window. */
  toggleSessionPin: (key: string) => void
  /** Hide a session from the picker + tab strip. Files on disk untouched. */
  hideSession: (key: string) => Promise<void>
  /** Restore a hidden session. */
  unhideSession: (key: string) => Promise<void>
  /** Toggle the per-session log direction. */
  toggleSessionDirection: (key: string) => void
  /** Toggle the per-session loud/quiet filter. */
  toggleSessionFilter: (key: string) => void
  /** Open / close the picker sheet. */
  setSessionPickerOpen: (open: boolean) => void

  // ── Shared mind ────────────────────────────────────────────────────────
  /** Pull queue + status + manifest from server. */
  refreshSharedMind: () => Promise<void>
  /** Add an entity to the publish queue. Idempotent — same id replaces. */
  queueForShared: (item: SharedQueueItem) => Promise<void>
  /** Remove a queued item by id. */
  unqueueShared: (id: string) => Promise<void>
  /** Refine a queued item's title/description/bodyOverride before publish. */
  editQueuedShared: (
    id: string,
    patch: { title?: string; description?: string; bodyOverride?: string },
  ) => Promise<void>
  /** Drain the queue: write files, commit, push (push optional). */
  publishShared: (opts?: { push?: boolean; message?: string }) => Promise<PublishResult>
  /** Pull from origin, import memories into graph as `shared:<name>` scope. */
  syncShared: () => Promise<SyncResult>
  /** Set the git remote URL on the working clone. */
  setSharedRemote: (url: string) => Promise<void>
  /** Patch the manifest (name + description). */
  setSharedManifest: (patch: { name?: string; description?: string }) => Promise<void>
  setGraphQuery: (q: string) => void
  setSelectedEntryId: (id: string | null) => void
  setCodeFocus: (id: string | null) => void
  triggerGraphSync: () => Promise<void>
  importObsidianVault: (vaultName: string, targets: string[]) => Promise<{ imported: number; skipped: number; errors: string[] }>
  /** Refresh graph stats + recent results + all-graph nodes from server. Call after imports/syncs. */
  refreshGraph: () => Promise<void>
  /** Refresh just the recent-activity buffer that drives the Sessions right rail. */
  refreshRecentActivity: () => Promise<void>
  /**
   * Run an async operation while marking it pending in `pendingOps`. The caller
   * supplies a stable key (e.g. `install:open-prose@prose`) that UI can observe
   * to render spinners / disable buttons specific to that target.
   */
  runOp: <T>(key: string, fn: () => Promise<T>) => Promise<T>
  setActiveTab: (kind: Kind, tabId: string) => void
  /**
   * Persist a new entity value immediately (no debounce, no optimistic update).
   * Use when a mutation needs to happen *durably before* the UI reflects it —
   * e.g. plugin enable/disable, where an orange "in-progress" indicator only
   * makes sense if we don't lie with an optimistic flip.
   */
  saveEntity: (entity: Entity<any>, next: any) => Promise<void>
}

type Store = State & Actions

const USER_SCOPE: Scope = { type: 'user' }

const selectionKey = (scope: Scope, kind: Kind): string =>
  `${scopeKey(scope)}::${kind}`

const resolveContext = (s: State): { loc: Location; home: string } | null => {
  const loc = resolveLocation(s.scope, s.home, s.projects)
  if (!loc) return null
  return { loc, home: s.home }
}

const resolveSelection = (
  buckets: EntitiesByKind,
  scope: Scope,
  kind: Kind,
  selections: Record<string, string>,
  currentId: string | null,
): string | null => {
  const list = buckets[kind]
  if (currentId && list.find((e) => e.id === currentId)) return currentId
  const remembered = selections[selectionKey(scope, kind)]
  if (remembered && list.find((e) => e.id === remembered)) return remembered
  return list[0]?.id ?? null
}

const writeTimers = new Map<string, ReturnType<typeof setTimeout>>()
let reloadTimer: ReturnType<typeof setTimeout> | null = null
let saveUiTimer: ReturnType<typeof setTimeout> | null = null
let saveSettingsTimer: ReturnType<typeof setTimeout> | null = null
let _graphSearchTimer: ReturnType<typeof setTimeout> | null = null

const withoutKind = (set: Set<Kind>, kind: Kind): Set<Kind> => {
  const next = new Set(set)
  next.delete(kind)
  return next
}

const patchBucket = (
  buckets: EntitiesByKind,
  kind: Kind,
  list: Entity<any>[],
): EntitiesByKind => ({ ...buckets, [kind]: list })

/**
 * Reconciles a fresh bucket read from disk with the in-memory bucket. Any
 * entity that is currently `dirty` (unsaved user edit) is retained — the
 * in-flight write will eventually land on disk and a later watcher event will
 * bring the two back in sync. Without this, an external watcher event in the
 * middle of typing would snap the editor back to the last-saved value.
 */
const mergeBucket = (
  previous: Entity<any>[],
  fresh: Entity<any>[],
): Entity<any>[] => {
  const dirty = new Map<string, Entity<any>>()
  for (const e of previous) if (e.dirty) dirty.set(e.id, e)
  if (dirty.size === 0) return fresh
  return fresh.map((f) => dirty.get(f.id) ?? f)
}

/** Max concurrent conversation enrichments — bounded to keep IPC humane. */
const ENRICH_CONCURRENCY = 8

/**
 * Background pool that parses conversation files to populate title / turn /
 * token metadata. Each completion is pushed to the store via `onEnriched` so
 * the list updates progressively. Aborts as soon as `isCurrent` returns false
 * (i.e. user switched scope).
 */
const runEnrichment = async (
  jobs: ConversationEnrichJob[],
  isCurrent: () => boolean,
  onEnriched: (entity: Entity<any>) => void,
): Promise<void> => {
  let cursor = 0
  const worker = async () => {
    while (isCurrent()) {
      const i = cursor++
      if (i >= jobs.length) return
      try {
        const enriched = await enrichConversation(jobs[i]!)
        if (!enriched || !isCurrent()) continue
        onEnriched(enriched)
      } catch {
        // best-effort: a single enrichment failure shouldn't block others
      }
    }
  }
  const width = Math.min(ENRICH_CONCURRENCY, jobs.length)
  await Promise.all(Array.from({ length: width }, worker))
}

/**
 * Accumulates external change paths across watcher fires so a burst (e.g. a
 * multi-file git operation) coalesces into a single refresh.
 */
const pendingRefreshPaths = new Set<string>()

/**
 * Re-reads only the kinds whose source data actually changed and commits all
 * buckets in a single `setState` so the UI re-renders once, not eleven times.
 * Does NOT touch `loadingKinds` — a targeted refresh is silent; the count in
 * the sidebar goes from N to N (or N±1 for a create/delete) atomically,
 * without flicker.
 *
 * Dirty entities (unsaved user edits) are preserved across the refresh via
 * `mergeBucket`.
 */
const refreshKinds = async (kinds: Set<Kind>): Promise<void> => {
  const state = useStore.getState()
  const ctx = resolveContext(state)
  if (!ctx) return
  const startScope = state.scope
  const stillCurrent = (): boolean =>
    scopeEq(useStore.getState().scope, startScope)

  let enrichJobs: ConversationEnrichJob[] = []
  const results = await Promise.all(
    Array.from(kinds).map(async (k) => {
      try {
        if (k === 'conversation') {
          const { entities, jobs } = await readConversations(ctx.loc, ctx.home)
          enrichJobs = jobs
          return [k, entities] as const
        }
        return [k, await readByKind(k, ctx.loc, ctx.home)] as const
      } catch {
        return null
      }
    }),
  )
  if (!stillCurrent()) return

  useStore.setState((s) => {
    let entities = s.entities
    for (const r of results) {
      if (!r) continue
      const [k, list] = r
      entities = patchBucket(entities, k, mergeBucket(s.entities[k], list))
    }
    const selectedId = resolveSelection(
      entities,
      s.scope,
      s.kind,
      s.selections,
      s.selectedId,
    )
    const all = Object.values(entities).flat() as AnyEntity[]
    return { entities, selectedId, refs: buildReferenceGraph(all) }
  })

  if (enrichJobs.length > 0) {
    void runEnrichment(enrichJobs, stillCurrent, (entity) => {
      useStore.setState((s) => ({
        entities: patchBucket(
          s.entities,
          'conversation',
          s.entities.conversation.map((e) =>
            e.path === entity.path ? entity : e,
          ),
        ),
      }))
    })
  }
}

const flushPendingRefresh = async (): Promise<void> => {
  if (pendingRefreshPaths.size === 0) return
  const paths = Array.from(pendingRefreshPaths)
  pendingRefreshPaths.clear()
  const state = useStore.getState()
  const ctx = resolveContext(state)
  if (!ctx) return
  const kinds = new Set<Kind>()
  for (const p of paths) {
    for (const k of kindsForPath(p, ctx.loc, ctx.home)) kinds.add(k)
  }
  if (kinds.size === 0) return
  await refreshKinds(kinds)
}

const scheduleUiSave = (state: State) => {
  if (saveUiTimer) clearTimeout(saveUiTimer)
  saveUiTimer = setTimeout(() => {
    if (!state.home) return
    void saveUiState(state.home, {
      selections: state.selections,
      lastScopeKey: scopeKey(state.scope),
      lastKind: state.kind,
      projectTags: state.projectTags,
      scopeTags: state.scopeTags,
      hiddenTags: Array.from(state.hiddenTags),
      hiddenSessionIds: Array.from(state.hiddenSessionIds),
    })
  }, 250)
}

// ── Cortex UI persistence (view + rail + session tab) ────────────────────────
const CORTEX_UI_KEY = 'cortex.ui.v1'
type PersistedUI = {
  view?: 'home' | 'config' | 'knowledge' | 'graph' | 'code' | 'sessions' | 'machines' | 'profile'
  railExpanded?: boolean
  sessionTab?: string
  pinnedSessions?: string[]
  sessionDirection?: Record<string, 'newest-top' | 'oldest-top'>
  sessionFilter?: Record<string, 'loud' | 'quiet'>
}
function loadCortexUI(): PersistedUI {
  if (typeof localStorage === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(CORTEX_UI_KEY) ?? '{}') as PersistedUI
  } catch {
    return {}
  }
}
function saveCortexUI(patch: PersistedUI) {
  if (typeof localStorage === 'undefined') return
  try {
    const current = loadCortexUI()
    localStorage.setItem(CORTEX_UI_KEY, JSON.stringify({ ...current, ...patch }))
  } catch {}
}
const _cortexUI = loadCortexUI()

export const useStore = create<Store>((set, get) => ({
  home: '',
  ready: false,
  profileEnabled: false,
  projects: [],
  scope: USER_SCOPE,
  kind: 'claudemd',
  selectedId: null,
  entities: emptyBuckets(),
  refs: [],
  search: '',
  lastError: null,
  selections: {},
  settings: defaultSettings(),
  pendingOps: new Set<string>(),
  loadingKinds: new Set<Kind>(),
  activeTab: {},
  globalEntityIds: {},
  projectTags: {},
  scopeTags: {},
  hiddenTags: new Set<string>(),
  // Always launch on the home view. (Previously restored the last-selected
  // view from localStorage, which left the app opening on graph for anyone
  // who'd visited it once. Home is the intended landing surface.)
  view: 'home',
  railExpanded: _cortexUI.railExpanded ?? false,
  sessionTab: _cortexUI.sessionTab ?? 'all',
  sessions: [],
  sessionStreams: {},
  sessionCursors: {},
  sessionLoading: {},
  sessionsWired: false,
  pinnedSessions: _cortexUI.pinnedSessions ?? [],
  hiddenSessionIds: new Set<string>(),
  sessionDirection: _cortexUI.sessionDirection ?? {},
  sessionFilter: _cortexUI.sessionFilter ?? {},
  sessionPickerOpen: false,
  graphQuery: '',
  graphResults: [],
  graphSearching: false,
  selectedEntryId: null,
  selectedEntry: null,
  graphEntryLoading: false,
  codeFocusId: null,
  graphStats: null,
  graphAllNodes: [],
  graphAllEdges: [],
  graphAllLoading: false,
  graphScopes: [],
  graphKinds: [],
  machines: [],
  machinesRetiredCount: 0,
  machineFilter: null,
  recentGraphActivity: [],
  sharedQueue: [],
  sharedStatus: null,
  sharedManifest: null,
  sharedBusy: false,
  sharedLastMessage: null,

  bootstrap: async () => {
    try {
      const home = await fs.homeDir()
      set({ home })
      await Promise.all([
        get().refreshProjects(),
        initTokenCache(home),
        initPersistentCaches(home),
      ])
      const ui = await loadUiState(home)
      const settings = await loadSettings(home)
      set({ settings })
      const restoredScope =
        (ui.lastScopeKey && scopeFromKey(ui.lastScopeKey)) || USER_SCOPE
      const rawKind = (ui.lastKind as Kind) ?? 'claudemd'
      const restoredKind = kindSupportsScope(rawKind, restoredScope)
        ? rawKind
        : (allKindsForScope(restoredScope)[0] ?? 'claudemd')
      set({
        scope: restoredScope,
        kind: restoredKind,
        selections: ui.selections,
        projectTags: ui.projectTags ?? {},
        scopeTags: ui.scopeTags ?? {},
        hiddenTags: new Set(ui.hiddenTags ?? []),
        hiddenSessionIds: new Set(ui.hiddenSessionIds ?? []),
      })
      await get().reload()
      const targets = watchTargetsFor(get().scope, home, get().projects)
      await fs.watchPaths(targets)
      await fs.onChange((ev) => {
        // Caches are path-keyed and cheap to invalidate — do it unconditionally
        // so even suppressed self-writes don't leave stale cache entries.
        for (const path of ev.paths) {
          invalidatePath(path)
          if (path.endsWith('.jsonl')) {
            invalidateConversation(path)
            invalidateToolResults(path)
          }
        }
        // Drop the echoes of our own writes; no refresh needed for those.
        const external = ev.paths.filter((p) => !isRecentSelfWrite(p))
        if (external.length === 0) return
        for (const p of external) pendingRefreshPaths.add(p)
        if (reloadTimer) clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => void flushPendingRefresh(), 150)
      })
      // Personality profile is surfaced only when the server has CKN_PROFILE on.
      let profileOn = false
      try {
        const r = await fetch('/api/profile/enabled')
        if (r.ok) profileOn = (await r.json())?.enabled === true
      } catch { /* default off — Profile UI stays hidden */ }
      set({ profileEnabled: profileOn })
      if (!profileOn && get().view === 'profile') set({ view: 'home' })
      set({ ready: true })
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) })
    }
  },

  refreshProjects: async () => {
    const projects = await loadProjects(get().home)
    set({ projects })
  },

  setScope: (scope) => {
    if (scopeEq(scope, get().scope)) return
    set((s) => {
      const kind = kindSupportsScope(s.kind, scope)
        ? s.kind
        : (allKindsForScope(scope)[0] ?? s.kind)
      return {
        scope,
        kind,
        selectedId: null,
        entities: emptyBuckets(),
        refs: [],
        loadingKinds: new Set<Kind>(allKinds),
      }
    })
    scheduleUiSave(get())
    void (async () => {
      await get().reload()
      const targets = watchTargetsFor(scope, get().home, get().projects)
      await fs.watchPaths(targets)
    })()
  },

  setKind: (kind) => {
    set((s) => {
      if (!kindSupportsScope(kind, s.scope)) return {}
      const selected = resolveSelection(
        s.entities,
        s.scope,
        kind,
        s.selections,
        null,
      )
      return { kind, selectedId: selected, search: '' }
    })
    scheduleUiSave(get())
  },

  setSelected: (id) => {
    set((s) => {
      if (!id) return { selectedId: null }
      const next = { ...s.selections, [selectionKey(s.scope, s.kind)]: id }
      return { selectedId: id, selections: next }
    })
    scheduleUiSave(get())
  },

  setSearch: (s) => set({ search: s }),

  reload: async () => {
    const state = get()
    const ctx = resolveContext(state)
    if (!ctx) {
      set({
        entities: emptyBuckets(),
        refs: [],
        selectedId: null,
        loadingKinds: new Set(),
      })
      return
    }
    const reloadScope = state.scope
    const stillCurrent = () => scopeEq(get().scope, reloadScope)

    set({ loadingKinds: new Set<Kind>(allKinds) })

    const commitKind = (k: Kind, list: Entity<any>[]) => {
      set((s) => {
        const entities = patchBucket(s.entities, k, list)
        return {
          entities,
          loadingKinds: withoutKind(s.loadingKinds, k),
          selectedId: resolveSelection(
            entities,
            s.scope,
            s.kind,
            s.selections,
            s.selectedId,
          ),
        }
      })
    }

    const clearLoading = (k: Kind, err?: unknown) => {
      set((s) => ({
        loadingKinds: withoutKind(s.loadingKinds, k),
        lastError:
          err === undefined
            ? s.lastError
            : err instanceof Error
              ? err.message
              : String(err),
      }))
    }

    let enrichJobs: ConversationEnrichJob[] = []

    const tasks = allKinds.map(async (k) => {
      try {
        if (k === 'conversation') {
          const { entities, jobs } = await readConversations(ctx.loc, ctx.home)
          if (!stillCurrent()) return
          enrichJobs = jobs
          commitKind('conversation', entities)
          return
        }
        const list = await readByKind(k, ctx.loc, ctx.home)
        if (!stillCurrent()) return
        commitKind(k, list)
      } catch (e) {
        if (!stillCurrent()) return
        clearLoading(k, e)
      }
    })

    await Promise.all(tasks)
    if (!stillCurrent()) return

    const all = Object.values(get().entities).flat() as AnyEntity[]
    set({ refs: buildReferenceGraph(all), lastError: null })

    // When viewing a project scope, fetch global entity names so we can show
    // "overrides global" badges in the list pane.
    if (reloadScope.type === 'project') {
      const globalLoc = resolveLocation({ type: 'user' }, state.home, state.projects)
      if (globalLoc) {
        const globalIds: Partial<Record<Kind, Set<string>>> = {}
        await Promise.all(
          allKinds.map(async (k) => {
            try {
              const list = await readByKind(k, globalLoc, state.home)
              globalIds[k] = new Set(list.map((e) => e.id))
            } catch {}
          }),
        )
        if (stillCurrent()) set({ globalEntityIds: globalIds })
      }
    } else {
      set({ globalEntityIds: {} })
    }

    if (enrichJobs.length > 0) {
      void runEnrichment(enrichJobs, stillCurrent, (entity) => {
        set((s) => ({
          entities: patchBucket(
            s.entities,
            'conversation',
            s.entities.conversation.map((e) =>
              e.path === entity.path ? entity : e,
            ),
          ),
        }))
      })
    }
  },

  updateEntity: (entity, next) => {
    set((s) => {
      const list = (s.entities as any)[entity.kind] as Entity<any>[]
      const updated = list.map((e) =>
        e.id === entity.id ? { ...e, value: next, dirty: true } : e,
      )
      return { entities: { ...s.entities, [entity.kind]: updated } }
    })
    const key = entity.id
    const prev = writeTimers.get(key)
    if (prev) clearTimeout(prev)
    writeTimers.set(
      key,
      setTimeout(async () => {
        const ctx = resolveContext(get())
        if (!ctx) return
        try {
          const current = (get().entities as any)[entity.kind].find(
            (e: Entity<any>) => e.id === entity.id,
          ) as Entity<any> | undefined
          const value = current?.value ?? next
          const writeCtx: WriteContext = { loc: ctx.loc, home: ctx.home }
          await adapterWrite(writeCtx, entity, value)
          // Clear `dirty` only if no further edit landed while we were writing.
          // If `current.value` is still what we just wrote, the user has stopped
          // typing and the on-disk state matches memory — the orange dot can go
          // away. If it changed, a later debounce will own the clear.
          set((s) => {
            const list = (s.entities as any)[entity.kind] as Entity<any>[]
            const idx = list.findIndex((e) => e.id === entity.id)
            if (idx < 0) return {}
            const item = list[idx]!
            if (!item.dirty || item.value !== value) return {}
            const cleaned = list.slice()
            cleaned[idx] = { ...item, dirty: false, origin: value }
            return { entities: { ...s.entities, [entity.kind]: cleaned } }
          })
        } catch (e) {
          set({ lastError: e instanceof Error ? e.message : String(e) })
        }
      }, 350),
    )
  },

  createNew: async (kind, _input, value) => {
    const ctx = resolveContext(get())
    if (!ctx) return
    try {
      await adapterCreate({ loc: ctx.loc, home: ctx.home }, kind, value)
      await refreshKinds(new Set([kind]))
      set({ kind })
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) })
    }
  },

  deleteExisting: async (entity) => {
    const ctx = resolveContext(get())
    if (!ctx) return
    try {
      await adapterDelete({ loc: ctx.loc, home: ctx.home }, entity)
      if (get().selectedId === entity.id) set({ selectedId: null })
      await refreshKinds(new Set([entity.kind]))
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) })
    }
  },

  copyToScope: async (entity, target) => {
    const state = get()
    const targetLoc = resolveLocation(target, state.home, state.projects)
    if (!targetLoc) return
    try {
      await adapterCreate(
        { loc: targetLoc, home: state.home },
        entity.kind,
        entity.value,
      )
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) })
    }
  },

  moveToScope: async (entity, target) => {
    await get().copyToScope(entity, target)
    await get().deleteExisting(entity)
  },

  createIn: async (kind, value, target) => {
    const state = get()
    const targetLoc = resolveLocation(target, state.home, state.projects)
    if (!targetLoc) return
    try {
      await adapterCreate({ loc: targetLoc, home: state.home }, kind, value)
      // Only refresh if the target scope is the one currently on screen;
      // otherwise the change is off-screen and will be picked up when the
      // user switches to that scope.
      if (scopeEq(target, state.scope)) {
        await refreshKinds(new Set([kind]))
      }
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) })
    }
  },

  addProject: async (path, name) => {
    await addManualProject(get().home, path, name)
    await get().refreshProjects()
  },

  removeProject: async (project) => {
    await removeManualProject(get().home, project.path)
    await get().refreshProjects()
  },

  updateProjectTags: async (projectId, tags) => {
    const next = { ...get().projectTags, [projectId]: tags }
    set({ projectTags: next })
    scheduleUiSave({ ...get(), projectTags: next })
  },

  updateScopeTags: async (scopeKey, tags) => {
    const current = get().scopeTags
    // Drop the key entirely if it has no tags — keeps ui-state.json tidy.
    const next = { ...current }
    if (tags.length === 0) delete next[scopeKey]
    else next[scopeKey] = tags
    set({ scopeTags: next })
    scheduleUiSave({ ...get(), scopeTags: next })
  },

  toggleHiddenTag: async (tag) => {
    const prev = get().hiddenTags
    const next = new Set(prev)
    if (next.has(tag)) next.delete(tag)
    else next.add(tag)
    set({ hiddenTags: next })
    scheduleUiSave({ ...get(), hiddenTags: next })
  },

  updateSettings: (next) => {
    set({ settings: next })
    if (saveSettingsTimer) clearTimeout(saveSettingsTimer)
    saveSettingsTimer = setTimeout(() => {
      const { home, settings } = get()
      if (home) void saveSettings(home, settings)
    }, 300)
  },

  setActiveTab: (kind, tabId) =>
    set((s) => ({ activeTab: { ...s.activeTab, [kind]: tabId } })),

  toggleRail: () => {
    const next = !get().railExpanded
    set({ railExpanded: next })
    saveCortexUI({ railExpanded: next })
  },

  setSessionTab: (tab) => {
    set({ sessionTab: tab })
    saveCortexUI({ sessionTab: tab })
  },

  refreshSessions: async () => {
    try {
      const sessions = await fetchSessionList()
      set({ sessions })
    } catch {}
  },

  ensureSessionsWired: () => {
    if (get().sessionsWired) return
    set({ sessionsWired: true })
    subscribeSessions((ev) => {
      if (ev.type === 'session:append') {
        const key = ev.id
        set((s) => {
          const existing = s.sessionStreams[key] ?? []
          // Drop any overlap — fromLine should equal cursor, but be defensive.
          const filteredExisting = existing.filter((l) => l.line < ev.fromLine)
          return {
            sessionStreams: {
              ...s.sessionStreams,
              [key]: [...filteredExisting, ...ev.lines],
            },
            sessionCursors: { ...s.sessionCursors, [key]: ev.nextLine },
          }
        })
      } else if (ev.type === 'session:state') {
        const meta = ev.meta
        set((s) => {
          const idx = s.sessions.findIndex(
            (m) => m.projectDir === meta.projectDir && m.id === meta.id,
          )
          let nextSessions: SessionMeta[]
          if (idx >= 0) {
            nextSessions = s.sessions.slice()
            nextSessions[idx] = meta
          } else {
            nextSessions = [meta, ...s.sessions]
          }
          // Re-sort by mtime so the freshest sessions are first.
          nextSessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
          return { sessions: nextSessions }
        })
      } else if (ev.type === 'session:state-tier') {
        // Lightweight transition update — only the live tier changed.
        set((s) => {
          const idx = s.sessions.findIndex((m) => sessionKey(m) === ev.id)
          if (idx < 0) return {}
          const next = s.sessions.slice()
          next[idx] = { ...next[idx]!, liveState: ev.liveState }
          return { sessions: next }
        })
      } else if (ev.type === 'graph:sync') {
        // Server says the graph just changed (memory sync, vault import,
        // scope delete). Refresh stats + the rail's recent-activity buffer.
        // Skip the heavier refreshGraph() unless we're actually on the
        // Knowledge / Graph view — those buffers don't matter to Sessions.
        void graphStats().then((s) => set({ graphStats: s })).catch(() => {})
        void get().refreshRecentActivity()
        const v = get().view
        if (v === 'knowledge' || v === 'graph') {
          void get().refreshGraph()
        }
      }
    })
  },

  loadSessionStream: async (key) => {
    if (get().sessionLoading[key]) return
    const [projectDir, ...rest] = key.split('/')
    const sessionId = rest.join('/')
    if (!projectDir || !sessionId) return
    set((s) => ({ sessionLoading: { ...s.sessionLoading, [key]: true } }))
    try {
      const result = await fetchSessionRange(projectDir, sessionId, 0)
      set((s) => ({
        sessionStreams: { ...s.sessionStreams, [key]: result.lines },
        sessionCursors: { ...s.sessionCursors, [key]: result.nextLine },
        sessionLoading: { ...s.sessionLoading, [key]: false },
      }))
    } catch {
      set((s) => ({ sessionLoading: { ...s.sessionLoading, [key]: false } }))
    }
  },

  toggleSessionPin: (key) => {
    set((s) => {
      const has = s.pinnedSessions.includes(key)
      const next = has
        ? s.pinnedSessions.filter((k) => k !== key)
        : [...s.pinnedSessions, key]
      saveCortexUI({ pinnedSessions: next })
      return { pinnedSessions: next }
    })
  },

  hideSession: async (key) => {
    const next = new Set(get().hiddenSessionIds)
    next.add(key)
    set({ hiddenSessionIds: next })
    // Hiding a session also drops it from the active tab if selected.
    if (get().sessionTab === key) {
      set({ sessionTab: 'all' })
      saveCortexUI({ sessionTab: 'all' })
    }
    scheduleUiSave({ ...get(), hiddenSessionIds: next })
  },

  unhideSession: async (key) => {
    const next = new Set(get().hiddenSessionIds)
    next.delete(key)
    set({ hiddenSessionIds: next })
    scheduleUiSave({ ...get(), hiddenSessionIds: next })
  },

  toggleSessionDirection: (key) => {
    set((s) => {
      const cur = s.sessionDirection[key] ?? 'newest-top'
      const nextDir: 'newest-top' | 'oldest-top' =
        cur === 'newest-top' ? 'oldest-top' : 'newest-top'
      const next: Record<string, 'newest-top' | 'oldest-top'> = {
        ...s.sessionDirection,
        [key]: nextDir,
      }
      saveCortexUI({ sessionDirection: next })
      return { sessionDirection: next }
    })
  },

  toggleSessionFilter: (key) => {
    set((s) => {
      const cur = s.sessionFilter[key] ?? 'loud'
      const nextFilter: 'loud' | 'quiet' = cur === 'loud' ? 'quiet' : 'loud'
      const next: Record<string, 'loud' | 'quiet'> = {
        ...s.sessionFilter,
        [key]: nextFilter,
      }
      saveCortexUI({ sessionFilter: next })
      return { sessionFilter: next }
    })
  },

  setSessionPickerOpen: (open) => set({ sessionPickerOpen: open }),

  // ── Shared mind ────────────────────────────────────────────────────────

  refreshSharedMind: async () => {
    const localPath = get().settings.sharedMind?.localPath || undefined
    try {
      const { status, queue, manifest } = await fetchSharedStatus(localPath)
      set({ sharedStatus: status, sharedQueue: queue, sharedManifest: manifest })
    } catch {
      // best-effort — if server is briefly down, keep prior state
    }
  },

  queueForShared: async (item) => {
    const localPath = get().settings.sharedMind?.localPath || undefined
    try {
      const queue = await sharedQueueAdd(item, localPath)
      set({ sharedQueue: queue, sharedLastMessage: `queued: ${item.title}` })
    } catch (e) {
      set({ sharedLastMessage: e instanceof Error ? e.message : String(e) })
    }
  },

  unqueueShared: async (id) => {
    const localPath = get().settings.sharedMind?.localPath || undefined
    try {
      const queue = await sharedQueueRemove(id, localPath)
      set({ sharedQueue: queue })
    } catch {}
  },

  editQueuedShared: async (id, patch) => {
    const localPath = get().settings.sharedMind?.localPath || undefined
    try {
      const queue = await sharedQueueUpdate(id, patch, localPath)
      set({ sharedQueue: queue })
    } catch {}
  },

  publishShared: async (opts = {}) => {
    const localPath = get().settings.sharedMind?.localPath || undefined
    set({ sharedBusy: true, sharedLastMessage: 'publishing…' })
    try {
      const result = await sharedPublish({
        ...opts,
        localPath,
        publishedBy: undefined, // server defaults to env USER
      })
      const msg = result.pushError
        ? `committed (${result.itemsWritten}) — push failed: ${result.pushError}`
        : result.pushed
          ? `published ${result.itemsWritten} item${result.itemsWritten === 1 ? '' : 's'} → pushed`
          : `committed ${result.itemsWritten} item${result.itemsWritten === 1 ? '' : 's'} (no push)`
      set({ sharedLastMessage: msg, sharedBusy: false })
      // Pull fresh status post-publish.
      await get().refreshSharedMind()
      return result
    } catch (e) {
      set({
        sharedBusy: false,
        sharedLastMessage: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  },

  syncShared: async () => {
    const localPath = get().settings.sharedMind?.localPath || undefined
    set({ sharedBusy: true, sharedLastMessage: 'syncing…' })
    try {
      const result = await sharedSync(localPath)
      const msg = result.pullError
        ? `import: +${result.imported} (pull warning: ${result.pullError})`
        : `synced: pulled, +${result.imported} memor${result.imported === 1 ? 'y' : 'ies'} into graph`
      set({ sharedLastMessage: msg, sharedBusy: false })
      // Refresh shared status + the rail's recent activity since new memories landed.
      await Promise.all([get().refreshSharedMind(), get().refreshRecentActivity()])
      return result
    } catch (e) {
      set({
        sharedBusy: false,
        sharedLastMessage: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  },

  setSharedRemote: async (url) => {
    const localPath = get().settings.sharedMind?.localPath || undefined
    try {
      await sharedSetRemote(url, localPath)
      // Persist to settings so it survives restarts.
      const next = { ...get().settings, sharedMind: { ...get().settings.sharedMind, remoteUrl: url } }
      set({ settings: next })
      if (saveSettingsTimer) clearTimeout(saveSettingsTimer)
      saveSettingsTimer = setTimeout(() => {
        const { home, settings } = get()
        if (home) void saveSettings(home, settings)
      }, 300)
      await get().refreshSharedMind()
    } catch (e) {
      set({ sharedLastMessage: e instanceof Error ? e.message : String(e) })
      throw e
    }
  },

  setSharedManifest: async (patch) => {
    const localPath = get().settings.sharedMind?.localPath || undefined
    try {
      const manifest = await sharedSetManifest(patch, localPath)
      set({ sharedManifest: manifest })
      // Mirror name + description into settings so the UI can show them
      // even before refreshSharedMind hits the server.
      const next = {
        ...get().settings,
        sharedMind: {
          ...get().settings.sharedMind,
          name: manifest.name,
          description: manifest.description ?? '',
        },
      }
      set({ settings: next })
    } catch {}
  },

  saveEntity: async (entity, next) => {
    const ctx = resolveContext(get())
    if (!ctx) throw new Error('No location for scope')
    await adapterWrite({ loc: ctx.loc, home: ctx.home }, entity, next)
  },

  setView: (view) => {
    const previous = get().view
    set({ view })
    saveCortexUI({ view })
    // Subtle "▸ <view>" toast on every change. Skip if it's the same view (no-op).
    if (previous !== view) {
      // Lazy-imported to avoid pulling sonner into store cycles in tests.
      void import('sonner').then(({ toast }) => toast(`▸ ${view}`, { duration: 1400 }))
    }
    if (view === 'knowledge') {
      void graphStats().then((s) => set({ graphStats: s })).catch(() => {})
      void graphListScopes().then((scopes) => set({ graphScopes: scopes })).catch(() => {})
      void graphListKinds().then((kinds) => set({ graphKinds: kinds })).catch(() => {})
      const q = get().graphQuery
      if (!q.trim()) {
        set({ graphSearching: true })
        void graphListRecent().then((r) => set({ graphResults: r, graphSearching: false })).catch(() => set({ graphSearching: false }))
      }
    }
    if (view === 'graph') {
      void graphStats().then((s) => set({ graphStats: s })).catch(() => {})
      set({ graphAllLoading: true })
      void graphAll()
        .then(({ nodes, edges }) => set({ graphAllNodes: nodes, graphAllEdges: edges, graphAllLoading: false }))
        .catch(() => set({ graphAllLoading: false }))
    }
    if (view === 'sessions') {
      void get().refreshSessions()
      get().ensureSessionsWired()
      // Right rail data — graph stats + recent-write entries.
      void graphStats().then((s) => set({ graphStats: s })).catch(() => {})
      void get().refreshRecentActivity()
    }
    if (view === 'home') {
      // Home view's corner tags read the same fields the Sessions rail does
      // (sessions list, graph stats, recent activity, scopes for the vault
      // pill). Subscribe to the WS stream too so live data flows in.
      void get().refreshSessions()
      get().ensureSessionsWired()
      void graphStats().then((s) => set({ graphStats: s })).catch(() => {})
      void graphListScopes().then((scopes) => set({ graphScopes: scopes })).catch(() => {})
      void get().refreshRecentActivity()
    }
    if (view === 'machines') {
      void graphListMachines().then((r) => set({ machines: r.machines, machinesRetiredCount: r.retiredCount })).catch(() => {})
    }
  },

  setGraphQuery: (q) => {
    set({ graphQuery: q })
    if (!q.trim()) {
      set({ graphSearching: true })
      void graphListRecent().then((r) => set({ graphResults: r, graphSearching: false })).catch(() => set({ graphSearching: false }))
      return
    }
    set({ graphSearching: true })
    if (_graphSearchTimer) clearTimeout(_graphSearchTimer)
    _graphSearchTimer = setTimeout(async () => {
      try {
        const results = await graphSearch(q)
        // Only apply if the query hasn't changed
        if (get().graphQuery === q) set({ graphResults: results, graphSearching: false })
      } catch {
        set({ graphSearching: false })
      }
    }, 250)
  },

  setSelectedEntryId: (id) => {
    set({ selectedEntryId: id, selectedEntry: null })
    if (!id) return
    set({ graphEntryLoading: true })
    void (async () => {
      try {
        let entry = await graphGetEntry(id)
        // `/node/:id` only knows Entry (memory) nodes. A code-graph symbol node
        // (overlay) has no Entry row, so fall back to the symbol endpoint and map
        // it into the drawer's shape — symbol nodes then get the same detail pane
        // as memory nodes (kind 'symbol' → violet tone; dependents/dependencies
        // become backlinks/links so you can jump through the call/import graph).
        if (!entry) {
          const nb = await graphSymbolNeighborhood(id)
          if (nb?.symbol) {
            const s = nb.symbol
            const toLink = (d: GraphSymbol): GraphLink => ({
              id: d.id,
              name: d.name,
              kind: d.symbolKind || 'symbol',
              label: d.symbolKind,
            })
            entry = {
              id: s.id,
              name: s.name,
              // Use the REAL symbolKind (function/module/class/…) so the drawer
              // reads consistently with the Code view; the `repo:` scope marks it
              // as a code-graph node (drives the type-aware "open in code" action).
              kind: s.symbolKind || 'symbol',
              description: s.file ? `${s.file}:${s.line}` : '',
              scope: s.repo ? `repo:${s.repo}` : '',
              updatedAt: s.lastSeen || 0,
              content: [
                `${s.symbolKind} ${s.name}`,
                s.file ? `${s.file}:${s.line}${s.lang ? ` (${s.lang})` : ''}` : '',
                s.repo ? `repo: ${s.repo}` : '',
                `dependents (centrality): ${s.centrality}`,
                s.signature ? `\n${s.signature}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
              source: s.file,
              links: nb.dependencies.map(toLink),
              backlinks: nb.dependents.map(toLink),
            } satisfies GraphEntryDetail
          }
        }
        if (get().selectedEntryId === id) set({ selectedEntry: entry, graphEntryLoading: false })
      } catch {
        if (get().selectedEntryId === id) set({ graphEntryLoading: false })
      }
    })()
  },

  setCodeFocus: (id) => set({ codeFocusId: id }),

  importObsidianVault: async (vaultName, targets) => {
    const result = await graphImportVault(vaultName, targets)
    await get().refreshGraph()
    return result
  },

  refreshGraph: async () => {
    try {
      const [stats, scopes, kinds] = await Promise.all([
        graphStats(),
        graphListScopes().catch(() => []),
        graphListKinds().catch(() => []),
      ])
      set({ graphStats: stats, graphScopes: scopes, graphKinds: kinds })
      const q = get().graphQuery
      const results = q.trim() ? await graphSearch(q) : await graphListRecent()
      set({ graphResults: results })
      if (get().view === 'graph') {
        const { nodes, edges } = await graphAll()
        set({ graphAllNodes: nodes, graphAllEdges: edges })
      }
      // Sessions rail buffer is independent of graphResults — refresh too.
      void get().refreshRecentActivity()
    } catch {
      // best-effort refresh
    }
  },

  refreshRecentActivity: async () => {
    try {
      // Pull 200 most-recently-synced entries. Plenty for an hour-long
      // sparkline and the newest-memory list, even during heavy activity.
      const entries = await graphListRecent(200, { sort: 'synced' })
      set({ recentGraphActivity: entries })
    } catch {
      // best-effort
    }
  },

  triggerGraphSync: async () => {
    try {
      await graphSync()
      // Single source of truth for post-sync refresh — also pulls scope + kind
      // aggregations so the Context sidebar updates after sync, not just stats.
      await get().refreshGraph()
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) })
    }
  },

  runOp: async (key, fn) => {
    if (get().pendingOps.has(key)) {
      throw new Error(`${key} is already in progress`)
    }
    set((s) => ({ pendingOps: new Set(s.pendingOps).add(key) }))
    try {
      return await fn()
    } finally {
      set((s) => {
        const next = new Set(s.pendingOps)
        next.delete(key)
        return { pendingOps: next }
      })
    }
  },
}))
