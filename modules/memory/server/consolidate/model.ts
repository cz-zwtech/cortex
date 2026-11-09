/**
 * The consolidation model call: a headless `claude -p` on the subscription.
 *
 * Headless runs carry three known hazards (memory: headless claude -p and the
 * prompt hooks): prompt hooks inject into them, a turn spent on a tool fails
 * the call, and a model with tools off can still write a fake tool call. So
 * tools are off, the Cortex nudges are switched off for this process only,
 * stdin carries the prompt and then closes, and the answer must parse as the
 * JSON asked for or the batch is rejected. Never `--bare`: it forces API-key
 * auth, which bills the API instead of the subscription.
 */
import { spawnSync } from 'node:child_process'

export type ModelResult = { text: string; tokens: number; costUsd: number; error?: string }
export type ModelCall = (prompt: string, opts: { model: string; effort?: string; timeoutMs?: number }) => ModelResult

/**
 * The child's environment: the caller's, minus every Cortex override. A
 * headless session still fires the user's real hooks; with a test's or a dev
 * run's CKN_STATE_DIR or CKN_MODULES_DIR inherited, its SessionStart re-sync
 * rewrote the real CLAUDE.md imports and commands from the wrong state (27 Oct).
 */
export const headlessEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('CKN_') && k !== 'CORTEX_UNDER_TEST') out[k] = v
  return { ...out, CKN_WATCHER_NUDGE: 'off', CKN_AUTO_SNAPSHOT: 'off' }
}

export const claudeCall: ModelCall = (prompt, opts) => {
  const args = ['-p', '--model', opts.model, '--output-format', 'json', '--tools', '', ...(opts.effort ? ['--effort', opts.effort] : [])]
  const r = spawnSync(process.env.CKN_CLAUDE_BIN ?? 'claude', args, {
    input: prompt,
    encoding: 'utf-8',
    timeout: opts.timeoutMs ?? 300_000,
    env: headlessEnv(process.env),
    maxBuffer: 32 * 1024 * 1024,
  })
  if (r.error || r.status !== 0) return { text: '', tokens: 0, costUsd: 0, error: `claude exited ${r.status ?? r.error?.message}: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}` }
  try {
    const j = JSON.parse(r.stdout) as { result?: string; is_error?: boolean; total_cost_usd?: number; usage?: Record<string, number> }
    const u = j.usage ?? {}
    const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    if (j.is_error) return { text: '', tokens, costUsd: j.total_cost_usd ?? 0, error: `model error: ${String(j.result).slice(0, 300)}` }
    return { text: j.result ?? '', tokens, costUsd: j.total_cost_usd ?? 0 }
  } catch {
    return { text: '', tokens: 0, costUsd: 0, error: 'claude output was not JSON' }
  }
}

/** The first JSON object in a model answer: models wrap answers in prose or fences. */
export const jsonOf = (text: string): unknown => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}
