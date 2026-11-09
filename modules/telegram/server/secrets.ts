/**
 * Where a bot's token, an operator's chat id or the publish token comes from:
 * named in telegram.json as a secret reference, never the value.
 *
 *   { "from": "bao", "path": "kv/cortex/secrets", "key": "TG_..." }
 *       read from OpenBao when the service starts, through bao-run (its AppRole
 *       login), held in memory only. An environment variable of the same name
 *       is never read: there is no fallback (31 Oct 2026).
 *   { "from": "env", "name": "TG_..." }
 *       for an install without OpenBao, said explicitly in the config.
 *
 * There is no default anywhere: a reference that is missing, or resolves to
 * nothing, refuses the bot.
 */

import { spawnSync } from 'node:child_process'
import { z } from 'zod'

const Key = z.string().regex(/^[A-Z][A-Z0-9_]*$/)

export const SecretRef = z.discriminatedUnion('from', [
  z.object({ from: z.literal('bao'), path: z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/), key: Key }).strict(),
  z.object({ from: z.literal('env'), name: Key }).strict(),
])
export type SecretRef = z.infer<typeof SecretRef>

export const describeRef = (r: SecretRef): string => (r.from === 'bao' ? `OpenBao ${r.path} ${r.key}` : `env ${r.name}`)

export type Resolve = (ref: SecretRef) => string | undefined

/**
 * Resolve references for real: env from the process, bao through bao-run on the
 * PATH (or CKN_BAO_RUN). One bao-run per distinct key, at start only.
 */
export const resolver = (env: NodeJS.ProcessEnv = process.env): Resolve => {
  const cache = new Map<string, string | undefined>()
  return (ref) => {
    if (ref.from === 'env') return env[ref.name]?.trim() || undefined
    const id = `${ref.path}#${ref.key}`
    if (!cache.has(id)) {
      const r = spawnSync(env.CKN_BAO_RUN || 'bao-run', [ref.key, '--', 'printenv', ref.key], {
        env: { ...env, BAO_SECRET_PATH: ref.path, [ref.key]: '' },
        encoding: 'utf-8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      cache.set(id, r.status === 0 ? r.stdout.trim() || undefined : undefined)
    }
    return cache.get(id)
  }
}

/** A Telegram bot token's shape. One written into telegram.json itself is refused. */
export const LITERAL_TOKEN = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/
