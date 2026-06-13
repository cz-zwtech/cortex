import { z } from 'zod'
import { LooseStringArray } from './schema'

export const Command = z.object({
  name: z.string().min(1),
  path: z.string().default(''),
  description: z.string().default(''),
  argumentHint: z.string().optional(),
  allowedTools: LooseStringArray.optional(),
  model: z.enum(['sonnet', 'opus', 'haiku', 'inherit']).optional(),
  body: z.string().default(''),
})
export type Command = z.infer<typeof Command>

export const emptyCommand = (name: string): Command => ({
  name,
  path: '',
  description: '',
  body: `Describe what /${name} does.\n`,
})
