import { z } from 'zod'

export const Project = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  exists: z.boolean().default(true),
})
export type Project = z.infer<typeof Project>

export const projectIdOf = (path: string): string =>
  path.replace(/[\/\\]/g, '').replace(/:/g, '')

export const projectNameOf = (path: string): string => {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
