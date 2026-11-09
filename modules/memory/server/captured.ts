/** Publishes `memory.captured` for each ingested memory: how other modules learn of new memories without polling. */
import type { ModuleCtx } from '../../../core/ctx.js'
import { frontmatterOf } from './frontmatter.js'
import type { MemoryRecord } from './journal.js'
import { MEMORY_CAPTURED, type CapturedPayload } from './types.js'

export const publishCaptured =
  (ctx: Pick<ModuleCtx, 'events' | 'log'>) =>
  ({ id, record }: { id: string; record: MemoryRecord }): void => {
    const payload: CapturedPayload = {
      id,
      machine: record.machine,
      seq: record.seq,
      ...(record.slug ? { slug: record.slug } : {}),
      shape: frontmatterOf(record.content).shape,
      ...(record.syncClass ? { syncClass: record.syncClass } : {}),
      ...(record.session ? { session: record.session } : {}),
    }
    ctx.events.publish(MEMORY_CAPTURED, payload).catch((err: unknown) => ctx.log(`memory.captured not delivered: ${err instanceof Error ? err.message : String(err)}`))
  }
