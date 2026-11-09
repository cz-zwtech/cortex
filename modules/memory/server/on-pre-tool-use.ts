/**
 * The PreToolUse subscriber — memory's first lifecycle hook.
 *
 * Thin on purpose. Everything decidable lives in `reflex.ts` where it is
 * testable without a harness; this file only translates between the harness's
 * payload shape and that decision, and it is the ONLY place that knows the
 * difference.
 *
 * FAILURE POLICY: this returns `undefined` on any internal error rather than
 * throwing. The dispatcher already isolates a throwing subscriber, so throwing
 * would not break the session — but it WOULD register as a module failure and
 * consume the event's error budget over something that is, at worst, a missed
 * hint. The one case that must not fail quietly is a secret deny, and that path
 * cannot reach the catch: `scanForSecrets` is pure over a string.
 */

import path from 'node:path'

import type { ModuleCtx } from '../../../core/ctx.js'
import { memoryRoots } from '../../../core/paths.js'
import { reflex, toResponse, type ToolPayload } from './reflex.js'
import { MemoryStore } from './store.js'

/**
 * Which scope this file belongs to.
 *
 * `~/.claude/memory/x.md`                      → user
 * `~/.claude/projects/<encoded-cwd>/memory/x.md` → <encoded-cwd>
 *
 * Derived from the path rather than configured, because the layout already
 * encodes it and a second source of truth would drift from the first. Stated
 * here rather than assumed: the sweep takes its scope as an argument, so this is
 * the first place the convention is written down as code.
 */
export const scopeForPath = (file: string): string => {
  const segs = path.resolve(file).split(path.sep)
  const i = segs.lastIndexOf('projects')
  if (i >= 0 && segs[i + 1]) return segs[i + 1]!
  return 'user'
}

const handler = (payload: unknown, ctx?: ModuleCtx) => {
  if (!ctx?.db) return undefined

  const p = (payload ?? {}) as ToolPayload
  const file = p.tool_input?.file_path
  if (typeof file !== 'string' || !file) return undefined

  try {
    const verdict = reflex(p, {
      store: new MemoryStore(ctx.db),
      scope: scopeForPath(file),
      roots: memoryRoots(),
    })

    // Only the interesting outcomes are worth a line. A log entry per tool call
    // would bury the ones that matter under the ones that do not.
    if (verdict.kind === 'deny') {
      ctx.log(`write-time reflex DENIED a write into ${path.basename(file)} — ${verdict.findings.length} finding(s)`)
    } else if (verdict.kind === 'no-corpus') {
      // Loud once per invocation, to the operator rather than the model. A dedupe
      // pass that answers "no duplicates" against an empty graph is reporting
      // success for a system that has never stored anything.
      ctx.log(
        `write-time reflex: dedupe SKIPPED — the graph holds NO memories at all, so this ` +
          `answered "no duplicates" without looking at anything (scope "${verdict.scope}"). ` +
          `Nothing currently drives ingest.`,
      )
    } else if (verdict.kind === 'inform') {
      ctx.log(`write-time reflex: ${verdict.matched.length} possible duplicate(s) for ${path.basename(file)}`)
    }

    return toResponse(verdict)
  } catch (err) {
    ctx.log(`write-time reflex failed (write allowed): ${err instanceof Error ? err.message : err}`)
    return undefined
  }
}

export default handler
