/**
 * Stop: capture this session's transcript up to now, within a small budget.
 * Whatever the budget leaves is picked up by the next Stop or the catch-up.
 */
import path from 'node:path'

import type { ModuleCtx } from '../../../core/ctx.js'
import { machineId } from '../../../core/machineId.js'
import { memoryRoots, memoryRootsAreDeclared } from '../../../core/paths.js'
import { memoryDirs } from './drive.js'
import { captureFile } from './context/capture.js'
import { contextStorePath } from './context/hooks.js'
import { ContextStore } from './context/store.js'
import { takeSurfaced, usedIn } from './context/depth.js'
import { lastReply } from './ruleAudit.js'
import { MemoryStore } from './store.js'
import { gradeShown } from './surfacing.js'

const BUDGET_MS = 400

export default (payload: unknown, ctx: ModuleCtx) => {
  const p = (payload ?? {}) as { transcript_path?: string; agent_id?: string; session_id?: string; last_assistant_message?: string }
  if (!p.transcript_path || p.agent_id) return undefined
  const store = new ContextStore(contextStorePath(ctx.dataDir))
  try {
    captureFile(store, { path: p.transcript_path, session: path.basename(p.transcript_path, '.jsonl') }, machineId(), {
      deadline: Date.now() + BUDGET_MS,
      memoryDirs: memoryDirs(memoryRoots(), 3, memoryRootsAreDeclared()),
    })
  } catch (err) {
    ctx.log(`transcript capture skipped this turn: ${err instanceof Error ? err.message : String(err)}`)
  }
  // What the answer used of the dialogue recall showed this turn: those blocks are `used`, the rest stay `related`.
  try {
    const shown = p.session_id ? takeSurfaced(ctx.dataDir, p.session_id) : undefined
    const reply = shown ? (p.last_assistant_message ?? (p.transcript_path ? lastReply(p.transcript_path) : '')) : ''
    if (shown && reply) {
      const used = shown.blocks.filter((b) => usedIn(reply, b))
      if (used.length) {
        store.touchHeat(used.map((b) => String(b.id)), 'block', 'used')
        store.markPullUsed(p.session_id!, shown.at)
      }
    }
  } catch (err) {
    ctx.log(`heat grading skipped this turn: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    store.close()
  }
  // What the answer used of the memories the prompt showed: only those count as usage.
  try {
    const reply = p.last_assistant_message ?? lastReply(p.transcript_path)
    if (ctx.db && p.session_id && reply) gradeShown(new MemoryStore(ctx.db), ctx.dataDir, p.session_id, reply, Date.now())
  } catch (err) {
    ctx.log(`memory use grading skipped this turn: ${err instanceof Error ? err.message : String(err)}`)
  }
  return undefined
}
