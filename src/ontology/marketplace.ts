import { z } from 'zod'

export const MarketplaceSourceObject = z.union([
  z.object({
    source: z.literal('github'),
    repo: z.string(),
    ref: z.string().optional(),
    sha: z.string().optional(),
  }),
  z.object({
    source: z.literal('url'),
    url: z.string(),
    ref: z.string().optional(),
    sha: z.string().optional(),
  }),
  z.object({
    source: z.literal('git-subdir'),
    url: z.string(),
    path: z.string(),
    ref: z.string().optional(),
  }),
  z.object({ source: z.literal('path'), path: z.string() }),
  z.object({ source: z.string() }).passthrough(),
])
export type MarketplaceSourceObject = z.infer<typeof MarketplaceSourceObject>

/**
 * Render a structured source as a human-readable string for display.
 */
export const formatMarketplaceSource = (s: MarketplaceSourceObject | string): string => {
  if (typeof s === 'string') return s
  if ('repo' in s && typeof s.repo === 'string') return `github:${s.repo}`
  if ('url' in s && typeof s.url === 'string') return s.url
  if ('path' in s && typeof s.path === 'string') return s.path
  return JSON.stringify(s)
}

/**
 * A registered Claude Code marketplace.
 *
 * Persisted in `~/.claude/plugins/known_marketplaces.json`. Add/remove/refresh
 * are managed by the `claude` CLI — this app shells out for those mutations.
 *
 * For new entries (not yet in known_marketplaces.json), `source` holds the
 * raw user input string passed to `claude plugin marketplace add`. After
 * the CLI runs and the file watcher picks up the change, the entry is
 * reloaded with structured `source` data.
 */
export const Marketplace = z.object({
  name: z.string().min(1),
  source: z.union([MarketplaceSourceObject, z.string()]),
  installLocation: z.string().optional(),
  lastUpdated: z.string().optional(),
})
export type Marketplace = z.infer<typeof Marketplace>

export const emptyMarketplace = (sourceInput: string): Marketplace => ({
  name: sourceInput,
  source: sourceInput,
})
