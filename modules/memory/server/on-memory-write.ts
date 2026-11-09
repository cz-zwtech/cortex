/**
 * PostToolUse: a memory the session just wrote is recallable in the same
 * session, not only after the next session start or end.
 *
 * Ingest ran only at the session edges, so a memory written mid-session was
 * missing from recall until then (desktop, 27 Oct: four memories written that
 * day, found only after a manual sweep). After a Write or Edit of a markdown
 * file in a memory directory (or a shell command that names one), that
 * directory is ingested now.
 *
 * Never consumed here: the session that wrote the file may edit it again in a
 * minute, and a file turned into a stub under it would break that edit. The
 * session-end sweep consumes as before; ingesting the same text again is a
 * no-op, and an edited version supersedes by source.
 */
import path from 'node:path'

import type { ModuleCtx } from '../../../core/ctx.js'
import { machineId } from '../../../core/machineId.js'
import { memoryRoots, memoryRootsAreDeclared } from '../../../core/paths.js'
import { ContextStore } from './context/store.js'
import { contextStorePath } from './context/hooks.js'
import { memoryDirs, scopeForDir } from './drive.js'
import { publishCaptured } from './captured.js'
import { Journal } from './journal.js'
import { MemoryStore } from './store.js'
import { sweep } from './sweep.js'

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

/** The memory directories this tool call wrote into, if any. */
export const writtenMemoryDirs = (payload: { tool_name?: string; tool_input?: Record<string, unknown> }, dirs: string[]): string[] => {
  const input = payload.tool_input ?? {}
  if (payload.tool_name && WRITE_TOOLS.has(payload.tool_name)) {
    const file = typeof input.file_path === 'string' ? path.resolve(input.file_path) : ''
    if (!file.endsWith('.md')) return []
    return dirs.filter((d) => path.dirname(file) === path.resolve(d))
  }
  if (payload.tool_name === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command
    return dirs.filter((d) => cmd.includes(path.resolve(d)) || cmd.includes(d))
  }
  return []
}

export default (payload: unknown, ctx: ModuleCtx) => {
  if (!ctx.db) return undefined
  const p = (payload ?? {}) as { tool_name?: string; tool_input?: Record<string, unknown>; session_id?: string }
  if (!p.tool_name || (!WRITE_TOOLS.has(p.tool_name) && p.tool_name !== 'Bash')) return undefined
  try {
    const dirs = writtenMemoryDirs(p, memoryDirs(memoryRoots(), 3, memoryRootsAreDeclared()))
    if (!dirs.length) return undefined
    // The writing session's kind decides a memory's sync class; capture has recorded it by now.
    const context = new ContextStore(contextStorePath(ctx.dataDir))
    try {
      const deps = {
        store: new MemoryStore(ctx.db),
        journal: new Journal({ dir: path.join(ctx.dataDir, 'journal'), machine: machineId() }),
        sessionInfo: (session: string) => context.sessionInfo(machineId(), session),
        onIngested: publishCaptured(ctx),
      }
      for (const dir of dirs) {
        const r = sweep({ memoryDir: dir, scope: scopeForDir(dir), machine: machineId(), sessionId: p.session_id, consume: false }, deps)
        if (r.ingested || r.declined) ctx.log(`memory written in-session: ${r.ingested} ingested, ${r.declined} held by the secret gate (${dir})`)
      }
    } finally {
      context.close()
    }
  } catch (err) {
    ctx.log(`in-session ingest skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
  return undefined
}
