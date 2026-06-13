import { z } from 'zod'
import { LooseStringArray } from './schema'

export const AgentModel = z.enum(['sonnet', 'opus', 'haiku', 'inherit'])
export type AgentModel = z.infer<typeof AgentModel>

export const Agent = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  tools: LooseStringArray.optional(),
  model: AgentModel.optional(),
  color: z.string().optional(),
  body: z.string().default(''),
})
export type Agent = z.infer<typeof Agent>

export const emptyAgent = (name: string): Agent => ({
  name,
  description: '',
  body: `# ${name}\n\nDescribe what this agent does.\n`,
})
