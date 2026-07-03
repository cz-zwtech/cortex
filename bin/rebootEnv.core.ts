/**
 * Pure core for ckn-reboot's env resolution (#139 A). The old startServer forced
 * CKN_PRIVATE_MIND/CKN_EMBEDDINGS to 'off' whenever they were undefined in the
 * reboot shell — silently downgrading a node that was RUNNING full mode (and
 * ckn-mind-sync inherited that off verdict, halting federation). The fix reads
 * the running server's actual booted env (via /proc/<pid>/environ) and carries
 * it forward; a downgrade only happens when the caller explicitly asks (--lean
 * or an explicit env var). Kept pure so the decision is unit-testable.
 */

/** Parse /proc/<pid>/environ (NUL-separated KEY=VALUE) into a map. */
export const parseEnviron = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const kv of raw.split('\0')) {
    if (!kv) continue
    const i = kv.indexOf('=')
    if (i <= 0) continue
    out[kv.slice(0, i)] = kv.slice(i + 1)
  }
  return out
}

/** The running server's mode, read from its booted env. A field is absent when
 *  it couldn't be determined (e.g. /proc unreadable). */
export interface LiveMode {
  privateMind?: string
  embeddings?: string
}

export interface RebootEnvInputs {
  /** CKN_PRIVATE_MIND / CKN_EMBEDDINGS as set in the reboot shell (explicit override). */
  explicit: { privateMind?: string; embeddings?: string }
  /** --lean / CKN_REBOOT_LEAN: opt into the old force-off lean boot. */
  lean: boolean
  /** The running server's mode, carried forward when nothing overrides it. */
  live: LiveMode
}

export interface RebootEnvResult {
  /** undefined => leave the var unset so the server applies its own default
   *  (never a forced downgrade). */
  privateMind?: string
  embeddings?: string
  warnings: string[]
}

const ENV_NAME: Record<string, string> = {
  'private-mind': 'CKN_PRIVATE_MIND',
  embeddings: 'CKN_EMBEDDINGS',
}

const resolveOne = (
  explicit: string | undefined,
  lean: boolean,
  live: string | undefined,
  label: 'private-mind' | 'embeddings',
  warnings: string[],
): string | undefined => {
  if (explicit !== undefined) return explicit // caller override wins
  if (lean) return 'off' // opt-in lean, deliberate
  if (live !== undefined) return live // carry the running mode forward — THE fix
  warnings.push(
    `could not determine the running ${label} mode; booting with the server ` +
      `default (may differ from the prior mode) — pass --lean to force lean, or ` +
      `set ${ENV_NAME[label]} explicitly`,
  )
  return undefined
}

export const resolveRebootEnv = (inp: RebootEnvInputs): RebootEnvResult => {
  const warnings: string[] = []
  const privateMind = resolveOne(inp.explicit.privateMind, inp.lean, inp.live.privateMind, 'private-mind', warnings)
  const embeddings = resolveOne(inp.explicit.embeddings, inp.lean, inp.live.embeddings, 'embeddings', warnings)
  return { privateMind, embeddings, warnings }
}
