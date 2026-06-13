/**
 * Shared, OpenBao-aware Anthropic API key resolver. Used by every hook that
 * makes an Anthropic call — ckn-extract (SessionEnd LLM extraction) and
 * ckn-name-session (Haiku name refinement) — so the secret-manager path is
 * resolved identically in one place. Resolution order:
 *   1. ANTHROPIC_API_KEY in env (however it got there), else
 *   2. if CKN_API_KEY_CMD is set, run it and use its stdout — a user-configured
 *      command that PRINTS the key (e.g. OpenBao:
 *      `bao-run ANTHROPIC_API_KEY -- printenv ANTHROPIC_API_KEY`). The key is
 *      fetched transiently and never written to a file or surfaced.
 *   3. else null.
 *
 * Graceful by design: a configured fetch that fails — vault down, key absent
 * (bao-run exits non-zero), timeout, empty stdout — resolves to null, so a
 * MISSING key behaves EXACTLY like an unset env var and the caller no-ops.
 * Because a secret manager's path is dynamic/user-specific, the fetch is opt-in
 * via CKN_API_KEY_CMD, never assumed.
 *
 * (When remote embeddings ship, mirror this with a CKN_EMBED_API_KEY_CMD for
 * the embedding provider key — same pattern, different env var.)
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const resolveAnthropicKey = async (): Promise<string | null> => {
  const direct = process.env.ANTHROPIC_API_KEY?.trim()
  if (direct) return direct
  const cmd = process.env.CKN_API_KEY_CMD?.trim()
  if (!cmd) return null
  try {
    const { stdout } = await execFileP('sh', ['-c', cmd], {
      timeout: 10_000,
      maxBuffer: 1 << 20,
    })
    return String(stdout).trim() || null
  } catch {
    return null // missing key / vault down / timeout → treat as no key (graceful)
  }
}
