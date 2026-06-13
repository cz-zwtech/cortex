import { z } from 'zod'
import { LooseStringArray } from './schema'

export const Rule = z.object({
  name: z.string().min(1),
  path: z.string().default(''),
  description: z.string().default(''),
  paths: LooseStringArray.optional(),
  body: z.string().default(''),
})
export type Rule = z.infer<typeof Rule>

export const emptyRule = (name: string): Rule => ({
  name,
  path: '',
  description: '',
  body: `# ${name}\n\nDescribe what this rule enforces.\n`,
})
