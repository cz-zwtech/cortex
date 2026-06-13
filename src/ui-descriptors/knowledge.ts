export const KNOWN_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
  'SlashCommand',
  'ExitPlanMode',
  'KillShell',
  'BashOutput',
  'AskUserQuestion',
  'Skill',
]

export const MODEL_OPTIONS = [
  { value: 'inherit', label: 'Inherit (default)' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
]

export const AGENT_COLORS = [
  { value: 'red', label: 'red' },
  { value: 'orange', label: 'orange' },
  { value: 'yellow', label: 'yellow' },
  { value: 'green', label: 'green' },
  { value: 'cyan', label: 'cyan' },
  { value: 'blue', label: 'blue' },
  { value: 'purple', label: 'purple' },
  { value: 'pink', label: 'pink' },
]

export const HOOK_EVENTS = [
  { value: 'PreToolUse', label: 'PreToolUse' },
  { value: 'PostToolUse', label: 'PostToolUse' },
  { value: 'UserPromptSubmit', label: 'UserPromptSubmit' },
  { value: 'Notification', label: 'Notification' },
  { value: 'Stop', label: 'Stop' },
  { value: 'SubagentStop', label: 'SubagentStop' },
  { value: 'SessionStart', label: 'SessionStart' },
  { value: 'PreCompact', label: 'PreCompact' },
]

export const MCP_TRANSPORTS = [
  { value: 'stdio', label: 'stdio' },
  { value: 'sse', label: 'sse' },
  { value: 'http', label: 'http' },
]
