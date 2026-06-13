import { z } from 'zod'

export const HookEvent = z.enum([
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'PreCompact',
])
export type HookEvent = z.infer<typeof HookEvent>

export const HookEvents: HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'PreCompact',
]

export const HookHandler = z.object({
  type: z.literal('command'),
  command: z.string().default(''),
  timeout: z.number().int().positive().optional(),
})
export type HookHandler = z.infer<typeof HookHandler>

export const Hook = z.object({
  event: HookEvent,
  matcher: z.string().default(''),
  index: z.number().int().nonnegative(),
  handlers: z.array(HookHandler).default([]),
})
export type Hook = z.infer<typeof Hook>

export const hookId = (h: Pick<Hook, 'event' | 'matcher' | 'index'>): string =>
  `${h.event}::${h.matcher}::${h.index}`

export const emptyHook = (event: HookEvent): Hook => ({
  event,
  matcher: '',
  index: 0,
  handlers: [{ type: 'command', command: '' }],
})
