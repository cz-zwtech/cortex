import type { Project, Scope } from '@/ontology'
import { join } from '@/adapters'

export const watchTargetsFor = (scope: Scope, home: string, projects: Project[]): string[] => {
  if (scope.type === 'user') {
    return [join(home, '.claude'), join(home, '.claude.json')]
  }
  const project = projects.find((p) => p.id === scope.projectId)
  if (!project) return []
  return [join(project.path, '.claude'), join(project.path, '.mcp.json')]
}
