import { Marketplace, type Entity, type MarketplaceSourceObject } from '@/ontology'
import { knownMarketplacesPath, type Location } from './paths'
import { fs, readJsonOrNull } from './fs'

interface KnownMarketplaceEntry {
  source?: MarketplaceSourceObject | string
  installLocation?: string
  lastUpdated?: string
  [k: string]: unknown
}

type KnownMarketplacesFile = Record<string, KnownMarketplaceEntry>

const scopeKey = (loc: Location) =>
  loc.scope.type === 'user' ? 'user' : loc.scope.projectId

export const readMarketplaces = async (
  loc: Location,
  home: string,
): Promise<Entity<Marketplace>[]> => {
  if (loc.scope.type !== 'user') return []

  const path = knownMarketplacesPath(home)
  const file = await readJsonOrNull<KnownMarketplacesFile>(path)
  if (!file) return []

  const entities: Entity<Marketplace>[] = []
  for (const [name, entry] of Object.entries(file)) {
    const value = Marketplace.parse({
      name,
      source: entry.source ?? '',
      installLocation: entry.installLocation,
      lastUpdated: entry.lastUpdated,
    })
    entities.push({
      id: `marketplace:${scopeKey(loc)}:${name}`,
      kind: 'marketplace',
      scope: loc.scope,
      path,
      value,
      origin: value,
      raw: JSON.stringify(entry),
    })
  }
  return entities
}

const sourceArg = (s: Marketplace['source']): string => {
  if (typeof s === 'string') return s
  if ('repo' in s && typeof s.repo === 'string') return s.repo
  if ('url' in s && typeof s.url === 'string') return s.url
  if ('path' in s && typeof s.path === 'string') return s.path
  throw new Error(`Cannot derive marketplace source argument from ${JSON.stringify(s)}`)
}

const failOnExit = (
  result: { stdout: string; stderr: string; exit_code: number },
  context: string,
): void => {
  if (result.exit_code === 0) return
  const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${result.exit_code}`)
  throw new Error(`${context}: ${detail}`)
}

/**
 * Add or update a marketplace by shelling out to the `claude` CLI.
 * Editing an existing entry is a no-op — name and source are managed by claude.
 */
export const writeMarketplace = async (
  loc: Location,
  _home: string,
  original: Entity<Marketplace> | null,
  next: Marketplace,
): Promise<void> => {
  if (loc.scope.type !== 'user') {
    throw new Error('Marketplaces are managed only at user scope')
  }
  if (original) {
    // No editable fields; mutations happen via custom actions (refresh) or delete + re-add.
    return
  }
  const arg = sourceArg(next.source)
  const result = await fs.runClaudeCli(['plugin', 'marketplace', 'add', arg])
  failOnExit(result, `claude plugin marketplace add ${arg}`)
}

export const deleteMarketplace = async (
  loc: Location,
  _home: string,
  entity: Entity<Marketplace>,
): Promise<void> => {
  if (loc.scope.type !== 'user') return
  const name = entity.origin.name
  const result = await fs.runClaudeCli(['plugin', 'marketplace', 'remove', name])
  failOnExit(result, `claude plugin marketplace remove ${name}`)
}

export const refreshMarketplace = async (name: string): Promise<void> => {
  const result = await fs.runClaudeCli(['plugin', 'marketplace', 'update', name])
  failOnExit(result, `claude plugin marketplace update ${name}`)
}
