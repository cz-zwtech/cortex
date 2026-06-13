import { Plugin, pluginKey, type Entity, type PluginScope, type PluginState } from '@/ontology'
import { installedPluginsPath, settingsPath, userPluginsDir, type Location } from './paths'
import { fs, join, readJsonOrNull } from './fs'

interface InstalledPluginEntry {
  scope?: PluginScope
  installPath?: string | null
  version?: string
  installedAt?: string
  lastUpdated?: string
  [k: string]: unknown
}

interface InstalledPluginsFile {
  version?: number
  plugins?: Record<string, InstalledPluginEntry[]>
}

interface SettingsShape {
  enabledPlugins?: Record<string, boolean>
  [k: string]: unknown
}

interface ManifestShape {
  description?: string
  author?: { name?: string; email?: string; url?: string } | string
  repository?: string
  homepage?: string
  keywords?: string[]
  license?: string
}

interface CatalogPluginEntry {
  name?: string
  description?: string
  author?: ManifestShape['author']
  source?: unknown
  category?: string
  homepage?: string
  repository?: string
  keywords?: string[]
  license?: string
  version?: string
  [k: string]: unknown
}

interface CatalogFile {
  name?: string
  plugins?: CatalogPluginEntry[]
}

const scopeKey = (loc: Location) =>
  loc.scope.type === 'user' ? 'user' : loc.scope.projectId

const readManifest = async (installPath: string | null | undefined): Promise<ManifestShape | null> => {
  if (!installPath) return null
  const manifestPath = join(installPath, '.claude-plugin', 'plugin.json')
  return readJsonOrNull<ManifestShape>(manifestPath)
}

const normalizeAuthor = (raw: ManifestShape['author']): Plugin['author'] => {
  if (!raw) return undefined
  if (typeof raw === 'string') return { name: raw }
  return { name: raw.name, email: raw.email, url: raw.url }
}

interface MergedPlugin {
  installed?: { entry: InstalledPluginEntry; manifest: ManifestShape | null }
  catalog?: { marketplace: string; entry: CatalogPluginEntry }
}

const readAllCatalogs = async (home: string): Promise<Map<string, CatalogPluginEntry>> => {
  const out = new Map<string, CatalogPluginEntry>()
  const root = userPluginsDir(home) + '/marketplaces'
  const exists = await fs.pathExists(root)
  if (!exists) return out

  const entries = await fs.listDir(root)
  for (const e of entries) {
    if (!e.is_dir) continue
    const catalogPath = join(e.path, '.claude-plugin', 'marketplace.json')
    const file = await readJsonOrNull<CatalogFile>(catalogPath)
    if (!file?.plugins) continue
    for (const p of file.plugins) {
      if (!p.name) continue
      out.set(`${p.name}@${e.name}`, p)
    }
  }
  return out
}

export const readPlugins = async (loc: Location, home: string): Promise<Entity<Plugin>[]> => {
  if (loc.scope.type !== 'user') return []

  const registryPath = installedPluginsPath(home)
  const [registry, settings, catalogMap] = await Promise.all([
    readJsonOrNull<InstalledPluginsFile>(registryPath),
    readJsonOrNull<SettingsShape>(settingsPath(loc)),
    readAllCatalogs(home),
  ])

  const enabledMap = settings?.enabledPlugins ?? {}
  const merged = new Map<string, MergedPlugin>()

  // Catalog entries first.
  for (const [pluginId, entry] of catalogMap) {
    merged.set(pluginId, { catalog: { marketplace: pluginId.split('@').pop()!, entry } })
  }

  // Overlay installed entries.
  for (const [pluginId, installs] of Object.entries(registry?.plugins ?? {})) {
    if (!Array.isArray(installs) || installs.length === 0) continue
    // If multiple installs share the id (e.g. multiple versions), use the first.
    // The registry's primary use is to track that this plugin is installed; the
    // editor's enabled toggle and version display reference one canonical entry.
    const install = installs[0]!
    const manifest = await readManifest(install.installPath)
    const existing = merged.get(pluginId) ?? {}
    existing.installed = { entry: install, manifest }
    merged.set(pluginId, existing)
  }

  const entities: Entity<Plugin>[] = []

  for (const [pluginId, { installed, catalog }] of merged) {
    const at = pluginId.lastIndexOf('@')
    if (at <= 0 || at === pluginId.length - 1) continue
    const name = pluginId.slice(0, at)
    const marketplace = pluginId.slice(at + 1)

    const state: PluginState =
      installed && catalog ? 'both' : installed ? 'installed' : 'available'

    const description =
      installed?.manifest?.description ?? catalog?.entry.description
    const author =
      normalizeAuthor(installed?.manifest?.author) ??
      normalizeAuthor(catalog?.entry.author)
    const repository = installed?.manifest?.repository ?? catalog?.entry.repository
    const homepage = installed?.manifest?.homepage ?? catalog?.entry.homepage
    const keywords = installed?.manifest?.keywords ?? catalog?.entry.keywords ?? []
    const license = installed?.manifest?.license ?? catalog?.entry.license

    const value = Plugin.parse({
      name,
      marketplace,
      state,
      version: installed?.entry.version ?? catalog?.entry.version,
      scope: installed?.entry.scope ?? (installed ? 'user' : undefined),
      installPath: installed?.entry.installPath ?? undefined,
      installedAt: installed?.entry.installedAt,
      lastUpdated: installed?.entry.lastUpdated,
      enabled: enabledMap[pluginId] === true,
      manifestFound: installed ? installed.manifest !== null : false,
      description,
      author,
      repository,
      homepage,
      keywords,
      license,
      category: catalog?.entry.category,
      source: catalog?.entry.source,
    })

    entities.push({
      id: `plugin:${scopeKey(loc)}:${pluginId}`,
      kind: 'plugin',
      scope: loc.scope,
      path: registryPath,
      value,
      origin: value,
      raw: JSON.stringify({ installed: installed?.entry, catalog: catalog?.entry }),
    })
  }

  return entities
}

const toRegistryEntry = (p: Plugin): InstalledPluginEntry => {
  const now = new Date().toISOString()
  return {
    scope: p.scope ?? 'user',
    installPath: p.installPath || null,
    version: p.version ?? '',
    installedAt: p.installedAt ?? now,
    lastUpdated: now,
  }
}

const removeInstall = (
  registry: InstalledPluginsFile,
  pluginId: string,
  version: string | undefined,
  scope: PluginScope | undefined,
): void => {
  const list = registry.plugins?.[pluginId]
  if (!list) return
  const next = list.filter(
    (e) => !(e.version === version && (e.scope ?? 'user') === (scope ?? 'user')),
  )
  if (next.length === 0) delete registry.plugins![pluginId]
  else registry.plugins![pluginId] = next
}

/**
 * Persist changes for an installed plugin entry. Currently only the
 * `enabled` flag is mutable through the UI, but we re-write the registry
 * row to keep timestamps fresh and allow future fields to ride along.
 *
 * Catalog-only entries (state === 'available') are not writable here —
 * install happens via the descriptor's "Install" custom action.
 */
export const writePlugin = async (
  loc: Location,
  home: string,
  original: Entity<Plugin> | null,
  next: Plugin,
): Promise<void> => {
  if (loc.scope.type !== 'user') {
    throw new Error('Plugins are currently managed only at user scope')
  }

  if (next.state === 'available') return // nothing to persist for catalog-only

  const registryPath = installedPluginsPath(home)
  const settings: SettingsShape = (await readJsonOrNull<SettingsShape>(settingsPath(loc))) ?? {}
  const registry: InstalledPluginsFile = (await readJsonOrNull<InstalledPluginsFile>(registryPath)) ?? {
    version: 2,
    plugins: {},
  }
  registry.plugins ??= {}

  const nextId = pluginKey(next)

  if (original) {
    const originId = pluginKey(original.origin)
    removeInstall(registry, originId, original.origin.version, original.origin.scope)
    if (originId !== nextId && !registry.plugins[originId]?.length) {
      if (settings.enabledPlugins && originId in settings.enabledPlugins) {
        delete settings.enabledPlugins[originId]
      }
    }
  }

  registry.plugins[nextId] ??= []
  registry.plugins[nextId] = registry.plugins[nextId].filter(
    (e) => !(e.version === next.version && (e.scope ?? 'user') === (next.scope ?? 'user')),
  )
  registry.plugins[nextId].push(toRegistryEntry(next))

  settings.enabledPlugins ??= {}
  settings.enabledPlugins[nextId] = next.enabled

  await fs.writeJson(registryPath, registry)
  await fs.writeJson(settingsPath(loc), settings)
}

/**
 * Uninstall a plugin via the `claude` CLI. This handles cache cleanup,
 * registry removal, and `enabledPlugins` cleanup atomically — far safer
 * than editing JSON directly.
 */
export const deletePlugin = async (
  loc: Location,
  _home: string,
  entity: Entity<Plugin>,
): Promise<void> => {
  if (loc.scope.type !== 'user') return
  if (entity.origin.state === 'available') return // nothing installed to remove
  await uninstallPlugin(pluginKey(entity.origin))
}

const failOnExit = (
  result: { stdout: string; stderr: string; exit_code: number },
  context: string,
): void => {
  if (result.exit_code === 0) return
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exit_code}`
  throw new Error(`${context}: ${detail}`)
}

/** Shell out to the `claude` CLI to install a plugin. */
export const installPlugin = async (id: string): Promise<void> => {
  const result = await fs.runClaudeCli(['plugin', 'install', id])
  failOnExit(result, `claude plugin install ${id}`)
}

/** Shell out to the `claude` CLI to uninstall a plugin. */
export const uninstallPlugin = async (id: string): Promise<void> => {
  const result = await fs.runClaudeCli(['plugin', 'uninstall', id])
  failOnExit(result, `claude plugin uninstall ${id}`)
}

/** Shell out to the `claude` CLI to update a plugin to its latest version. */
export const updatePluginCli = async (id: string): Promise<void> => {
  const result = await fs.runClaudeCli(['plugin', 'update', id])
  failOnExit(result, `claude plugin update ${id}`)
}
