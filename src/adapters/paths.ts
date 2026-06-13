import type { AnyEntity, Kind, Project, Scope } from '@/ontology'
import { claudeProjectEncoding } from '@/ontology'
import { join } from './fs'

export interface Location {
  scope: Scope
  root: string
}

const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

export const relPath = (absPath: string, root: string): string => {
  const a = normPath(absPath)
  const r = normPath(root)
  if (!r) return a
  if (a === r) return '.'
  if (a.startsWith(r + '/')) return a.slice(r.length + 1)
  return a
}

export const displayEntityPath = (
  entity: AnyEntity,
  home: string,
  projects: Project[],
): string => {
  const candidates: string[] = []
  const scope = entity.scope
  if (scope.type === 'user') {
    candidates.push(join(home, '.claude'))
  } else {
    const project = projects.find((p) => p.id === scope.projectId)
    if (project) {
      candidates.push(
        join(home, '.claude', 'projects', claudeProjectEncoding(project.path)),
      )
      candidates.push(project.path)
    }
  }
  const a = normPath(entity.path)
  let best = ''
  for (const c of candidates) {
    const n = normPath(c)
    if ((a === n || a.startsWith(n + '/')) && n.length > best.length) best = n
  }
  return best ? relPath(entity.path, best) : a
}

export const claudeDir = (loc: Location): string => join(loc.root, '.claude')
export const settingsPath = (loc: Location): string => join(claudeDir(loc), 'settings.json')
export const settingsLocalPath = (loc: Location): string =>
  join(claudeDir(loc), 'settings.local.json')
export const agentsDir = (loc: Location): string => join(claudeDir(loc), 'agents')
export const commandsDir = (loc: Location): string => join(claudeDir(loc), 'commands')
export const skillsDir = (loc: Location): string => join(claudeDir(loc), 'skills')
export const rulesDir = (loc: Location): string => join(claudeDir(loc), 'rules')

export const projectMcpPath = (loc: Location): string => join(loc.root, '.mcp.json')
export const userClaudeJson = (home: string): string => join(home, '.claude.json')

export const userPluginsDir = (home: string): string => join(home, '.claude', 'plugins')
export const installedPluginsPath = (home: string): string =>
  join(userPluginsDir(home), 'installed_plugins.json')
export const knownMarketplacesPath = (home: string): string =>
  join(userPluginsDir(home), 'known_marketplaces.json')

/**
 * Maps a filesystem path to the set of entity kinds whose buckets a change at
 * that path could affect. Used by the file-watcher to drive targeted reloads
 * instead of rescanning every kind on every event.
 *
 * Returns an empty set for paths we don't care about (logs, caches, etc.).
 */
export const kindsForPath = (
  path: string,
  loc: Location,
  home: string,
): Set<Kind> => {
  const p = normPath(path)
  const result = new Set<Kind>()
  const under = (prefix: string): boolean => {
    const n = normPath(prefix)
    return p === n || p.startsWith(n + '/')
  }

  if (under(join(claudeDir(loc), 'agents'))) result.add('agent')
  if (under(join(claudeDir(loc), 'commands'))) result.add('command')
  if (under(join(claudeDir(loc), 'skills'))) result.add('skill')
  if (under(join(claudeDir(loc), 'rules'))) result.add('rule')

  // settings.json + settings.local.json drive hooks + permissions; plugin
  // entities carry an `enabled` flag persisted in settings.json too.
  if (p === normPath(settingsPath(loc)) || p === normPath(settingsLocalPath(loc))) {
    result.add('hook')
    result.add('permission')
    result.add('plugin')
  }

  if (p === normPath(projectMcpPath(loc))) result.add('mcp')
  if (p === normPath(userClaudeJson(home))) result.add('mcp')
  if (p === normPath(installedPluginsPath(home))) result.add('plugin')
  if (p === normPath(knownMarketplacesPath(home))) result.add('marketplace')

  // Memory files live under ~/.claude/projects/<encoded>/memory/*.md.
  // Conversations live under ~/.claude/projects/<encoded>/*.jsonl.
  const projectsRoot = normPath(join(home, '.claude', 'projects'))
  if (under(projectsRoot)) {
    if (p.endsWith('.md') && p.includes('/memory/')) result.add('memory')
    if (p.endsWith('.jsonl')) result.add('conversation')
  }

  if (p.endsWith('/CLAUDE.md')) result.add('claudemd')

  return result
}
