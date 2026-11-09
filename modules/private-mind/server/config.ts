/**
 * mind.json, in this module's data dir (design 5.1). Without it the module
 * starts and does nothing; with it, nothing syncs until `enabled` is true
 * (27 Oct 2026: no cross-machine memory sync before private mind is built
 * and its first real run is approved).
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const SHAPE = z.enum(['decision', 'error', 'workflow', 'reference', 'feedback', 'pattern', 'observation', 'thread'])

export const MindConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** The node whose commits are the canonical lineage, and which runs the central-only stages. */
    central: z.string().min(1).optional(),
    /** The node that holds cold dialogue spans. */
    archival: z.string().min(1).optional(),
    syncEveryMin: z.number().positive().default(15),
    /** Shapes that stay home whatever session wrote them; a pointer travels instead. */
    working: z.object({ shapes: z.array(SHAPE).default(['workflow', 'thread']) }).strict().default({}),
    /** Roles whose memories are private to them: never leave their machine, not even as knowledge. */
    localRoles: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
    /**
     * Places whose memories are private, whoever wrote them: a memory whose project
     * scope lies under one of these, or written in a session working under one, stays
     * home. What covers a role's memories from before writer roles were recorded.
     */
    localDirs: z.array(z.string().startsWith('/')).default([]),
  })
  .strict()

export type MindConfig = z.infer<typeof MindConfigSchema>

export const configFile = (dataDir: string) => path.join(dataDir, 'mind.json')

/** The config, or undefined when there is none. A file that does not parse is an error, said plainly. */
export const loadConfig = (dataDir: string): MindConfig | undefined => {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(configFile(dataDir), 'utf-8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`mind.json: ${(err as Error).message}`)
  }
  const r = MindConfigSchema.safeParse(raw)
  if (!r.success) throw new Error(`mind.json: ${r.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`)
  return r.data
}
