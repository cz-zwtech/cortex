import { Project, projectIdOf, projectNameOf, type Scope } from '@/ontology'
import { fs, join, readJsonOrNull } from '@/adapters'
import type { Location } from '@/adapters'

interface ClaudeJsonShape {
  projects?: Record<string, unknown>
  [k: string]: unknown
}

const claudeJsonPath = (home: string): string => join(home, '.claude.json')

export const loadProjects = async (home: string): Promise<Project[]> => {
  const json = await readJsonOrNull<ClaudeJsonShape>(claudeJsonPath(home))
  const out: Project[] = []
  const seen = new Set<string>()
  for (const path of Object.keys(json?.projects ?? {})) {
    const id = projectIdOf(path)
    if (seen.has(id)) continue
    seen.add(id)
    const exists = await fs.pathExists(path)
    out.push({ id, path, name: projectNameOf(path), exists })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export const addManualProject = async (
  home: string,
  path: string,
  _name?: string,
): Promise<void> => {
  const cp = claudeJsonPath(home)
  const json = ((await readJsonOrNull<ClaudeJsonShape>(cp)) ?? {}) as ClaudeJsonShape
  json.projects = json.projects ?? {}
  if (!json.projects[path]) json.projects[path] = {}
  await fs.writeJson(cp, json)
}

export const removeManualProject = async (home: string, path: string): Promise<void> => {
  const cp = claudeJsonPath(home)
  const json = await readJsonOrNull<ClaudeJsonShape>(cp)
  if (!json?.projects) return
  if (!(path in json.projects)) return
  delete json.projects[path]
  await fs.writeJson(cp, json)
}

export const resolveLocation = (scope: Scope, home: string, projects: Project[]): Location | null => {
  if (scope.type === 'user') return { scope, root: home }
  const project = projects.find((p) => p.id === scope.projectId)
  if (!project) return null
  return { scope, root: project.path }
}
