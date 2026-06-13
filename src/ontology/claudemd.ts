import { z } from 'zod'

export const ClaudeMd = z.object({
  name: z.string().min(1),
  relPath: z.string().default(''),
  body: z.string().default(''),
})
export type ClaudeMd = z.infer<typeof ClaudeMd>

export const emptyClaudeMd = (relPath: string): ClaudeMd => ({
  name: relPath || 'CLAUDE.md',
  relPath: relPath || 'CLAUDE.md',
  body: '',
})
