import { z } from 'zod'

export const PluginScope = z.enum(['user', 'project', 'project-local'])
export type PluginScope = z.infer<typeof PluginScope>

export const PluginAuthor = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
})
export type PluginAuthor = z.infer<typeof PluginAuthor>

/** Where this entry was sourced from. */
export const PluginState = z.enum(['installed', 'available', 'both'])
export type PluginState = z.infer<typeof PluginState>

/**
 * A Claude Code plugin entry — may be installed, available in a marketplace
 * catalog, or both. The adapter merges these sources by `<name>@<marketplace>`.
 *
 * Persisted state spans:
 *   - ~/.claude/plugins/installed_plugins.json (registry: scope, installPath, version, timestamps)
 *   - ~/.claude/settings.json `enabledPlugins` map (enabled flag, keyed by `<name>@<marketplace>`)
 *   - ~/.claude/plugins/marketplaces/<mp>/.claude-plugin/marketplace.json (catalog: description, source, category)
 *   - <installPath>/.claude-plugin/plugin.json (manifest, when installed)
 */
export const Plugin = z.object({
  // Identity
  name: z.string().min(1),
  marketplace: z.string().min(1),

  /** Where this entry came from. Drives which fields are meaningful and which actions apply. */
  state: PluginState.default('available'),

  // Installed-only (only meaningful when state includes 'installed')
  version: z.string().optional(),
  scope: PluginScope.optional(),
  installPath: z.string().optional(),
  installedAt: z.string().optional(),
  lastUpdated: z.string().optional(),
  enabled: z.boolean().default(false),
  manifestFound: z.boolean().default(false),

  // Catalog/manifest
  description: z.string().optional(),
  author: PluginAuthor.optional(),
  repository: z.string().optional(),
  homepage: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  license: z.string().optional(),
  /** Marketplace catalog category (e.g. 'development', 'productivity'). */
  category: z.string().optional(),
  /** Marketplace catalog source descriptor — how the plugin would be fetched on install. */
  source: z.unknown().optional(),
})
export type Plugin = z.infer<typeof Plugin>

export const pluginKey = (p: Pick<Plugin, 'name' | 'marketplace'>): string =>
  `${p.name}@${p.marketplace}`

export const isInstalled = (p: Plugin): boolean =>
  p.state === 'installed' || p.state === 'both'

export const isAvailable = (p: Plugin): boolean =>
  p.state === 'available' || p.state === 'both'

export const emptyPlugin = (name: string): Plugin => ({
  name,
  marketplace: '',
  state: 'available',
  enabled: false,
  keywords: [],
  manifestFound: false,
})
