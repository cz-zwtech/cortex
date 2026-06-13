import { Plugin, emptyPlugin, isInstalled, pluginKey, type Entity } from '@/ontology'
import { installPlugin, uninstallPlugin, updatePluginCli } from '@/adapters/pluginAdapter'
import { fs } from '@/adapters'
import { runCliOp } from '@/app/cliOp'
import { useStore } from '@/app/store'
import { ColorDot, ExternalLink, Field, type ContextMenuItem } from '@/ui-primitives'
import { toast } from 'sonner'
import type { UiDescriptor } from './types'

const ReadOnlyText = ({ value, mono = false }: { value: string; mono?: boolean }) => (
  <div className={`text-sm text-zinc-300 ${mono ? 'font-mono break-all' : 'whitespace-pre-wrap'}`}>
    {value}
  </div>
)

const formatSource = (s: unknown): string => {
  if (!s) return ''
  if (typeof s === 'string') return s
  if (typeof s === 'object') {
    const o = s as Record<string, unknown>
    if (typeof o.repo === 'string') return `github:${o.repo}`
    if (typeof o.url === 'string') return o.url as string
    if (typeof o.path === 'string') return o.path as string
  }
  return JSON.stringify(s)
}

/**
 * In-marketplace bundled plugins have `source: "./plugins/..."` — a path
 * inside the marketplace repo, not an upstream. That's noise to surface,
 * so we only show Source for actual upstream pointers (github / url / path obj).
 */
const hasMeaningfulSource = (s: unknown): boolean => {
  if (!s) return false
  if (typeof s === 'string') return !s.startsWith('./') && !s.startsWith('../')
  return true
}

export const installOpKey = (id: string) => `install:${id}`
export const uninstallOpKey = (id: string) => `uninstall:${id}`
export const updateOpKey = (id: string) => `update:${id}`
export const enableOpKey = (id: string) => `enable:${id}`

/** True when any plugin-state mutation is in flight for this plugin. */
const anyOpPending = (ops: Set<string>, id: string): boolean =>
  ops.has(installOpKey(id)) ||
  ops.has(uninstallOpKey(id)) ||
  ops.has(updateOpKey(id)) ||
  ops.has(enableOpKey(id))

const doInstall = (id: string) =>
  runCliOp({
    key: installOpKey(id),
    loading: `Installing ${id}…`,
    success: `Installed ${id}`,
    action: () => installPlugin(id),
  }).catch(() => {})

const doUninstall = (id: string) => {
  if (!confirm(`Uninstall ${id}?`)) return
  return runCliOp({
    key: uninstallOpKey(id),
    loading: `Uninstalling ${id}…`,
    success: `Uninstalled ${id}`,
    action: () => uninstallPlugin(id),
  }).catch(() => {})
}

const doToggleEnabled = (entity: Entity<Plugin>) => {
  const id = pluginKey(entity.value)
  const nextEnabled = !entity.value.enabled
  return runCliOp({
    key: enableOpKey(id),
    loading: nextEnabled ? `Enabling ${id}…` : `Disabling ${id}…`,
    success: nextEnabled ? `Enabled ${id}` : `Disabled ${id}`,
    action: () => useStore.getState().saveEntity(entity, { ...entity.value, enabled: nextEnabled }),
  }).catch(() => {})
}

const doUpdate = (id: string) =>
  runCliOp({
    key: updateOpKey(id),
    loading: `Updating ${id}…`,
    success: `Updated ${id}`,
    action: () => updatePluginCli(id),
  })
    // Updating clears any "marked for update" flag — it's been resolved.
    .then(() => {
      const s = useStore.getState()
      const marks = s.settings.markedPlugins.filter((m) => m !== id)
      if (marks.length !== s.settings.markedPlugins.length) {
        s.updateSettings({ ...s.settings, markedPlugins: marks })
      }
    })
    .catch(() => {})

const toggleMarkForUpdate = (id: string) => {
  const s = useStore.getState()
  const marks = new Set(s.settings.markedPlugins)
  if (marks.has(id)) marks.delete(id)
  else marks.add(id)
  s.updateSettings({ ...s.settings, markedPlugins: [...marks] })
}

const openRepo = async (url: string) => {
  try {
    await fs.openExternal(url)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}

/** First available URL to show as "the repository" — repository > homepage. */
const repoUrl = (v: Plugin): string | null => v.repository ?? v.homepage ?? null

/**
 * Subscribes to `settings.markedPlugins` so the list indicator updates
 * reactively when the user marks/unmarks via the context menu or header.
 */
const MarkIndicator = ({ id }: { id: string }) => {
  const marked = useStore((s) => s.settings.markedPlugins.includes(id))
  return marked ? <ColorDot color="orange" title="Marked for update" /> : null
}

/**
 * The plugin's "status" indicator in the list. This is the single dot that
 * conveys both installation state (installed → green/grey by enabled flag,
 * available → no dot) AND in-flight mutations (any pending op → orange).
 * It subscribes to `pendingOps` so the dot flashes orange on install /
 * uninstall / update / enable / disable without a separate indicator.
 */
const PluginStatusDot = ({ value }: { value: Plugin }) => {
  const id = pluginKey(value)
  const pending = useStore((s) => anyOpPending(s.pendingOps, id))
  if (pending) return <ColorDot color="orange" title="In progress…" />
  if (isInstalled(value)) {
    return (
      <ColorDot
        color={value.enabled ? 'green' : 'grey'}
        title={value.enabled ? 'Enabled' : 'Disabled'}
      />
    )
  }
  return null
}

export const pluginDescriptor: UiDescriptor<Plugin> = {
  kind: 'plugin',
  newLabel: 'Add Plugin',
  newPromptLabel: 'Plugin name',
  newDefault: (name) => emptyPlugin(name),
  listLabel: (v) => (
    <span className="inline-flex items-center gap-2">
      <PluginStatusDot value={v} />
      <MarkIndicator id={pluginKey(v)} />
      <span className="truncate">{pluginKey(v)}</span>
    </span>
  ),
  listSublabel: (v) =>
    v.description ? <div className="truncate text-zinc-600">{v.description}</div> : null,
  headerTitle: (v) => (v.version ? `${v.name} · v${v.version}` : v.name),
  headerSubtitle: (v) => {
    if (!v.author?.name) return null
    const tooltip = [v.author.email, v.author.url].filter(Boolean).join(' · ')
    return <span title={tooltip || undefined}>{v.author.name}</span>
  },
  tabs: [
    { id: 'installed', label: 'Installed', predicate: (v) => isInstalled(v) },
    { id: 'marketplace', label: 'Marketplace', predicate: (v) => !isInstalled(v) },
  ],
  // Suppress the generic "Delete" affordance — uninstall is a CLI operation
  // that we surface explicitly (inline button + right-click) with toast UX.
  canDelete: () => false,
  // Context menu: plain verb actions, no icons, no stateful coloring.
  customActions: (entity: Entity<Plugin>) => {
    const id = pluginKey(entity.value)
    const state = useStore.getState()
    const pending = state.pendingOps
    const installPending = pending.has(installOpKey(id))
    const uninstallPending = pending.has(uninstallOpKey(id))
    const updatePending = pending.has(updateOpKey(id))
    const repo = repoUrl(entity.value)
    const marked = state.settings.markedPlugins.includes(id)

    const items: ContextMenuItem[] = []

    if (isInstalled(entity.value)) {
      const enabled = entity.value.enabled
      const enablePending = pending.has(enableOpKey(id))
      items.push({
        label: enabled ? 'Disable' : 'Enable',
        disabled: uninstallPending || updatePending || enablePending,
        onSelect: () => doToggleEnabled(entity),
      })
      items.push({
        label: 'Update',
        disabled: uninstallPending || updatePending || enablePending,
        onSelect: () => doUpdate(id),
      })
      items.push({
        label: marked ? 'Unmark for Update' : 'Mark for Update',
        onSelect: () => toggleMarkForUpdate(id),
      })
    } else {
      items.push({
        label: 'Install',
        disabled: installPending || uninstallPending,
        onSelect: () => doInstall(id),
      })
    }

    if (repo) {
      items.push({ label: 'View Repository', onSelect: () => openRepo(repo) })
    }

    if (isInstalled(entity.value)) {
      items.push({
        label: 'Uninstall',
        destructive: true,
        disabled: installPending || updatePending || uninstallPending,
        onSelect: () => doUninstall(id),
      })
    }

    return items
  },

  // Inspector header: stateful toggle button for Enabled, pending indicators, etc.
  headerActions: (entity: Entity<Plugin>) => {
    const id = pluginKey(entity.value)
    const state = useStore.getState()
    const pending = state.pendingOps
    const installPending = pending.has(installOpKey(id))
    const uninstallPending = pending.has(uninstallOpKey(id))
    const updatePending = pending.has(updateOpKey(id))
    const repo = repoUrl(entity.value)
    const marked = state.settings.markedPlugins.includes(id)

    const items: ContextMenuItem[] = []

    if (isInstalled(entity.value)) {
      const enabled = entity.value.enabled
      const enablePending = pending.has(enableOpKey(id))
      // Stateful toggle button: label stays "Enabled"; green = on, grey = off.
      // During an in-flight flip we keep the *current* active state (no optimistic
      // lie) and show a spinner via `pending` so the button communicates progress.
      items.push({
        label: 'Enabled',
        active: enabled,
        disabled: uninstallPending || updatePending || enablePending,
        pending: enablePending,
        onSelect: () => doToggleEnabled(entity),
      })
      items.push({
        label: updatePending ? 'Updating…' : 'Update',
        disabled: uninstallPending || enablePending,
        pending: updatePending,
        onSelect: () => doUpdate(id),
      })
      items.push({
        label: marked ? 'Unmark' : 'Mark for Update',
        onSelect: () => toggleMarkForUpdate(id),
      })
    } else {
      items.push({
        label: installPending ? 'Installing…' : 'Install',
        disabled: uninstallPending,
        pending: installPending,
        onSelect: () => doInstall(id),
      })
    }

    if (repo) {
      items.push({ label: 'View Repository', onSelect: () => openRepo(repo) })
    }

    if (isInstalled(entity.value)) {
      items.push({
        label: uninstallPending ? 'Uninstalling…' : 'Uninstall',
        destructive: true,
        disabled: installPending || updatePending,
        pending: uninstallPending,
        onSelect: () => doUninstall(id),
      })
    }

    return items
  },
  Editor: ({ value }) => {
    const hasMeta = !!(value.installedAt || value.lastUpdated || value.category)
    return (
      // Container query layout: the main column holds the primary fields
      // (Author → Repository → Install Path → Keywords → Description + any
      // extras), and the meta column shows install/update timestamps. When
      // the inspector is narrow the columns stack.
      <div className="@container">
        <div className="grid grid-cols-1 gap-x-8 gap-y-5 @[520px]:grid-cols-[minmax(0,1fr)_auto]">
          <div className="space-y-5 min-w-0">
            {value.author?.name && (
              <Field label="Author">
                <div
                  className="text-sm text-zinc-300"
                  title={
                    [value.author.email, value.author.url].filter(Boolean).join(' · ') ||
                    undefined
                  }
                >
                  {value.author.name}
                </div>
              </Field>
            )}

            {value.repository && (
              <Field label="Repository">
                <ExternalLink target={value.repository} mono title="Open in browser" />
              </Field>
            )}

            {value.installPath && (
              <Field label="Install Path">
                <ExternalLink
                  target={value.installPath}
                  mono
                  title="Open in file manager"
                />
              </Field>
            )}

            {hasMeaningfulSource(value.source) && (
              <Field label="Source">
                <ReadOnlyText value={formatSource(value.source)} mono />
              </Field>
            )}

            {value.homepage && (
              <Field label="Homepage">
                <ExternalLink target={value.homepage} mono title="Open in browser" />
              </Field>
            )}

            {value.license && (
              <Field label="License">
                <ReadOnlyText value={value.license} />
              </Field>
            )}

            {value.keywords.length > 0 && (
              <Field label="Keywords">
                <div className="flex flex-wrap gap-1">
                  {value.keywords.map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        const s = useStore.getState()
                        s.setActiveTab('plugin', 'marketplace')
                        s.setSearch(k)
                      }}
                      title={`Search marketplace for "${k}"`}
                      className="inline-block rounded bg-zinc-800 hover:bg-zinc-700 hover:text-orange-300 px-2 py-0.5 text-xs text-zinc-300 cursor-pointer"
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </Field>
            )}

            {value.description && (
              <Field label="Description">
                <ReadOnlyText value={value.description} />
              </Field>
            )}

            {isInstalled(value) && !value.manifestFound && value.installPath && (
              <Field label="Manifest">
                <div className="text-xs text-amber-500">
                  No plugin.json found at the install path.
                </div>
              </Field>
            )}
          </div>

          {hasMeta && (
            <div className="space-y-3 text-xs text-zinc-500 @[520px]:min-w-max">
              {value.category && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide">Category</div>
                  <div className="text-zinc-400">{value.category}</div>
                </div>
              )}
              {value.installedAt && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide">Installed</div>
                  <div className="text-zinc-400 font-mono">{value.installedAt}</div>
                </div>
              )}
              {value.lastUpdated && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide">Updated</div>
                  <div className="text-zinc-400 font-mono">{value.lastUpdated}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  },
}
