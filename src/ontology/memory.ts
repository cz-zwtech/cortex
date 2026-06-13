import { z } from 'zod'

export const MemoryType = z.enum(['user', 'feedback', 'project', 'reference'])
export type MemoryType = z.infer<typeof MemoryType>

export const Memory = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  type: MemoryType.default('project'),
  body: z.string().default(''),
})
export type Memory = z.infer<typeof Memory>

export const emptyMemory = (name: string): Memory => ({
  name,
  description: '',
  type: 'project',
  body: '',
})

export const claudeProjectEncoding = (projectPath: string): string =>
  projectPath.replace(/[\/\\:]/g, '-')

export const memorySlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'memory'
