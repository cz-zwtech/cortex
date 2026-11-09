/**
 * PreToolUse — the constraints that apply to what is about to be written or
 * sent, shown before it goes. Inform only: this never refuses a tool call.
 *
 * Prompt-time recall answers what was asked; a constraint matters at the moment
 * text leaves for someone else. Without this, a deck can be written with a
 * slide a meeting note said not to show its reader, and nothing looks at the deck.
 * Any file write counts, whatever its extension: a deck may be HTML, JSON or a
 * script that renders slides. Sends count as ruleAudit reads them.
 */

import os from 'node:os'
import path from 'node:path'

import type { ModuleCtx } from '../../../core/ctx.js'
import { machineId } from '../../../core/machineId.js'
import { applicableConstraints, CONSTRAINT_HEADING, constraintsShownSince, isShown, loadPrivacy, markConstraintsShown, renderConstraints, scopeOfCwd } from './constraints.js'
import { appendRecallLog } from './recallLog.js'
import { outboundText } from './ruleAudit.js'
import { MemoryStore } from './store.js'
import { indexSubjects } from './subjects.js'

type Payload = { tool_name?: string; tool_input?: Record<string, unknown>; session_id?: string; cwd?: string; agent_id?: string }

const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Enough of a long file to find who and what it is about. */
const MAX_TEXT = 20_000
/** A write repeated within this stretch already has the constraint in front of it. */
export const WRITE_REPEAT_MS = 10 * 60 * 1000

/** The text a tool call is about to put somewhere others will read, with its path. */
export const outgoing = (p: Payload): string | null => {
  const input = p.tool_input ?? {}
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (WRITES.has(p.tool_name ?? '')) {
    const edits = Array.isArray(input.edits) ? (input.edits as { new_string?: string }[]).map((e) => e.new_string ?? '').join('\n') : ''
    // The folder and the file name say who a write is for (a client folder); the rest of the path does not.
    const file = str('file_path') || str('notebook_path')
    const where = file ? `${path.basename(path.dirname(file))} ${path.basename(file)}`.replace(/[._-]+/g, ' ') : ''
    const text = [where, str('content'), str('new_string'), str('new_source'), edits].filter(Boolean).join('\n')
    return text ? text.slice(0, MAX_TEXT) : null
  }
  return outboundText(p)?.text.slice(0, MAX_TEXT) ?? null
}

export default (payload: unknown, ctx?: ModuleCtx) => {
  if (!ctx?.db) return undefined
  const p = (payload ?? {}) as Payload
  try {
    const text = outgoing(p)
    if (!text) return undefined
    const store = new MemoryStore(ctx.db)
    indexSubjects(store, { limit: 300, deadline: Date.now() + 200 })
    const now = Date.now()
    const seen = constraintsShownSince(ctx.dataDir, p.session_id, now - WRITE_REPEAT_MS)
    const list = applicableConstraints(store, {
      texts: [text],
      cwd: p.cwd,
      machine: [machineId(), os.hostname()],
      privacy: loadPrivacy(ctx.dataDir),
      skip: (c) => isShown(seen, c),
      gate: { people: store.peopleTokens(), ...(p.cwd ? { scope: scopeOfCwd(p.cwd) } : {}) },
    })
    if (!list.length) return undefined
    markConstraintsShown(ctx.dataDir, p.session_id, list, now)
    appendRecallLog(ctx.dataDir, {
      at: now,
      ...(p.session_id ? { session: p.session_id } : {}),
      event: 'write',
      via: 'constraints',
      terms: 0,
      expanded: 0,
      hits: [],
      shown: [],
      trimmed: [],
      suppressed: [],
      belowMinSim: 0,
      droppedForSize: 0,
      droppedByFloor: 0,
      constraints: list.map((c) => `${c.memoryId}#${c.ord}`),
    })
    const body = renderConstraints(list).replace(CONSTRAINT_HEADING, `${CONSTRAINT_HEADING} (to what this ${p.tool_name} writes or sends)`)
    return { additionalContext: `${body}\nCheck the text against these before it goes; this is a reminder, not a block.` }
  } catch (err) {
    ctx.log(`write-time constraints skipped (write allowed): ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}
