import { z } from 'zod'

export const PermissionMode = z.enum(['allow', 'deny', 'ask'])
export type PermissionMode = z.infer<typeof PermissionMode>

export const PermissionModes: PermissionMode[] = ['allow', 'deny', 'ask']

/**
 * A single permission rule within `~/.claude/settings.json` →
 * `permissions.{allow|deny|ask}` arrays.
 *
 * `pattern` is the raw rule string (e.g. `Bash(npm install)`, `Read(/path/**)`).
 * `index` is the rule's position within its mode array — needed so writes can
 * locate the original entry across renames.
 */
export const Permission = z.object({
  mode: PermissionMode,
  pattern: z.string().default(''),
  index: z.number().int().nonnegative(),
})
export type Permission = z.infer<typeof Permission>

export const permissionId = (
  p: Pick<Permission, 'mode' | 'index'>,
): string => `${p.mode}::${p.index}`

export const emptyPermission = (mode: PermissionMode = 'allow'): Permission => ({
  mode,
  pattern: '',
  index: 0,
})

/**
 * Split a rule string like `Bash(npm install *)` into tool + arg-spec.
 * Returns `{ tool: '', argSpec: pattern }` for malformed rules so the editor
 * still renders something useful while the user types.
 */
export const parsePermission = (
  pattern: string,
): { tool: string; argSpec: string } => {
  const m = pattern.match(/^([A-Za-z][\w-]*(?:__[\w-]+)*)\s*(?:\((.*)\))?\s*$/)
  if (!m) return { tool: '', argSpec: pattern }
  return { tool: m[1] ?? '', argSpec: m[2] ?? '' }
}

/**
 * Human-readable descriptions for the standard Claude Code tools, plus
 * documented MCP-prefixed tool names. Used by the permission editor's info
 * panel and as a tooltip in lists. `mcp__*` rules fall back to a generic
 * description since they're server-defined.
 */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  Bash: 'Execute shell commands. Argument is a glob pattern matched against the command line — `*` allows any args, `git status *` allows any git status invocation.',
  Read: 'Read files from the filesystem. Argument is a path glob — `**` matches any path, `/home/user/**` restricts to that directory.',
  Edit: 'Modify existing files in place via search-and-replace. Argument is a path glob.',
  Write: 'Create or overwrite files. Argument is a path glob.',
  Glob: 'Find files matching a glob pattern. Argument is a search-pattern glob.',
  Grep: 'Search file contents with ripgrep. Argument is a search-pattern glob.',
  WebFetch: 'Fetch the contents of a URL. Argument is a URL pattern.',
  WebSearch: 'Search the web. Argument is a query pattern.',
  Agent: 'Spawn a sub-agent to handle complex tasks. Argument restricts which agent types can be launched.',
  Task: 'Spawn a sub-agent (alias of Agent in older configs).',
  NotebookEdit: 'Edit Jupyter notebook cells. Argument is a path glob.',
  TodoWrite: 'Create and update the task list.',
  ExitPlanMode: 'Exit plan mode after presenting a plan.',
  KillShell: 'Terminate a running background shell process.',
  BashOutput: 'Read fresh stdout/stderr from a running background shell.',
  SlashCommand: 'Invoke a slash command (skill) defined in your config.',
  Skill: 'Invoke a skill — same as SlashCommand on newer Claude Code versions.',
  AskUserQuestion: 'Prompt the user with a structured multiple-choice question.',
  ListMcpResources: 'List resources exposed by configured MCP servers.',
  ReadMcpResource: 'Read a specific MCP resource.',
  ScheduleWakeup: 'Schedule a /loop continuation in dynamic mode.',
}

/**
 * Resolve a description for a tool name, including the `mcp__server__name`
 * convention used for MCP-exposed tools.
 */
export const describeTool = (tool: string): string => {
  if (!tool) return ''
  if (TOOL_DESCRIPTIONS[tool]) return TOOL_DESCRIPTIONS[tool]
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__')
    const server = parts[1] ?? ''
    const name = parts.slice(2).join('__')
    return `MCP tool exposed by the \`${server}\` server${name ? ` (${name})` : ''}. Defined by the MCP server itself, not Claude Code.`
  }
  return 'Custom or non-standard tool — no built-in description.'
}

