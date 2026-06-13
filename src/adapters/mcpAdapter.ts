import { McpServer, type Entity } from '@/ontology'
import { projectMcpPath, userClaudeJson, type Location } from './paths'
import { fs, readJsonOrNull } from './fs'

interface McpShape {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: 'stdio' | 'sse' | 'http'
  url?: string
}

interface ProjectMcpFile {
  mcpServers?: Record<string, McpShape>
}

interface UserClaudeJson {
  mcpServers?: Record<string, McpShape>
  [k: string]: unknown
}

const scopeKey = (loc: Location) =>
  loc.scope.type === 'user' ? 'user' : loc.scope.projectId

const toEntity = (loc: Location, path: string, name: string, raw: McpShape): Entity<McpServer> => {
  const value = McpServer.parse({
    name,
    type: raw.type ?? 'stdio',
    command: raw.command ?? '',
    args: raw.args ?? [],
    env: raw.env ?? {},
    url: raw.url,
    enabled: true,
  })
  return {
    id: `mcp:${scopeKey(loc)}:${name}`,
    kind: 'mcp',
    scope: loc.scope,
    path,
    value,
    origin: value,
    raw: JSON.stringify(raw),
  }
}

export const readMcpServers = async (loc: Location, home: string): Promise<Entity<McpServer>[]> => {
  if (loc.scope.type === 'user') {
    const path = userClaudeJson(home)
    const json = await readJsonOrNull<UserClaudeJson>(path)
    if (!json?.mcpServers) return []
    return Object.entries(json.mcpServers).map(([name, v]) => toEntity(loc, path, name, v))
  }
  const path = projectMcpPath(loc)
  const json = await readJsonOrNull<ProjectMcpFile>(path)
  if (!json?.mcpServers) return []
  return Object.entries(json.mcpServers).map(([name, v]) => toEntity(loc, path, name, v))
}

const toRaw = (s: McpServer): McpShape => {
  const out: McpShape = { type: s.type }
  if (s.command) out.command = s.command
  if (s.args.length) out.args = s.args
  if (Object.keys(s.env).length) out.env = s.env
  if (s.url) out.url = s.url
  return out
}

export const writeMcpServer = async (
  loc: Location,
  home: string,
  original: Entity<McpServer> | null,
  next: McpServer,
): Promise<void> => {
  const originalName = original?.origin.name
  if (loc.scope.type === 'user') {
    const path = userClaudeJson(home)
    const json = ((await readJsonOrNull<UserClaudeJson>(path)) ?? {}) as UserClaudeJson
    json.mcpServers ??= {}
    if (originalName && originalName !== next.name) delete json.mcpServers[originalName]
    json.mcpServers[next.name] = toRaw(next)
    await fs.writeJson(path, json)
    return
  }
  const path = projectMcpPath(loc)
  const json = (await readJsonOrNull<ProjectMcpFile>(path)) ?? {}
  json.mcpServers ??= {}
  if (originalName && originalName !== next.name) delete json.mcpServers[originalName]
  json.mcpServers[next.name] = toRaw(next)
  await fs.writeJson(path, json)
}

export const deleteMcpServer = async (
  loc: Location,
  home: string,
  entity: Entity<McpServer>,
): Promise<void> => {
  const name = entity.origin.name
  if (loc.scope.type === 'user') {
    const path = userClaudeJson(home)
    const json = (await readJsonOrNull<UserClaudeJson>(path)) ?? {}
    if (json.mcpServers) delete json.mcpServers[name]
    await fs.writeJson(path, json)
    return
  }
  const path = projectMcpPath(loc)
  const json = (await readJsonOrNull<ProjectMcpFile>(path)) ?? {}
  if (json.mcpServers) {
    delete json.mcpServers[name]
    await fs.writeJson(path, json)
  }
}
