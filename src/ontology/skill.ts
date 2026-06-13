import { z } from 'zod'
import { LooseStringArray } from './schema'

export const Skill = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  license: z.string().optional(),
  allowedTools: LooseStringArray.optional(),
  body: z.string().default(''),
})
export type Skill = z.infer<typeof Skill>

export const emptySkill = (name: string): Skill => ({
  name,
  description: '',
  body: `---\nname: ${name}\n---\n\n# ${name}\n\nDescribe what this skill does.\n`,
})
