/**
 * gateway.json: this gateway's domain, its peer gateways, and what each is
 * exposed. Edited on the box (its console, or SSH from the admin allowlist);
 * a signed config record comes later (trust doc section 9).
 *
 *   {
 *     "domain": "home",
 *     "listen": { "host": "0.0.0.0", "port": 28417 },
 *     "acceptActions": false,
 *     "peers": [
 *       { "domain": "partner", "address": "partner.example:28417", "pin": "<base64 sha-256 of its key>",
 *         "expose": [{ "human": "alex", "role": "acme-dev", "roles": ["dev"] }] }
 *     ],
 *     "denyList": ["internal codename"],
 *     "mailboxDays": 10,
 *     "pathIdleDays": 10,
 *     "limits": { "newPerMinute": 30, "banAfterFailures": 5, "banMinutes": 60 }
 *   }
 *
 * Every role is unexposed until listed (default unticked, new roles
 * included). A peer with no `address` is one that dials us.
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

export const EXTERNAL_PORT = 28417
const Name = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)

const Exposure = z.object({ human: Name, role: Name, roles: z.array(Name) }).strict()
const Peer = z
  .object({
    domain: Name,
    address: z.string().regex(/^[^\s/:]+:\d{1,5}$/, 'host:port').optional(),
    pin: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'the base64 SHA-256 of the peer key (cortex-gate key on the peer)'),
    expose: z.array(Exposure).default([]),
  })
  .strict()

export const GatewayConfig = z
  .object({
    domain: Name,
    listen: z.object({ host: z.string().default('0.0.0.0'), port: z.number().int().min(1).max(65535).default(EXTERNAL_PORT) }).default({}),
    acceptActions: z.boolean().default(false),
    peers: z.array(Peer).default([]),
    denyList: z.array(z.string().min(2)).default([]),
    mailboxDays: z.number().positive().default(10),
    pathIdleDays: z.number().positive().default(10),
    limits: z
      .object({
        newPerMinute: z.number().int().positive().default(30),
        banAfterFailures: z.number().int().positive().default(5),
        banMinutes: z.number().positive().default(60),
      })
      .default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    // This gateway never accepts actions (trust doc 3a): a config that would enable it is refused.
    if (c.acceptActions) ctx.addIssue({ code: 'custom', path: ['acceptActions'], message: 'this gateway never accepts actions; acceptActions must stay false' })
    const seen = new Set<string>()
    for (const p of c.peers) {
      if (seen.has(p.domain)) ctx.addIssue({ code: 'custom', path: ['peers'], message: `peer domain ${p.domain} is listed twice` })
      seen.add(p.domain)
      if (p.domain === c.domain) ctx.addIssue({ code: 'custom', path: ['peers'], message: 'a peer cannot be this gateway\'s own domain' })
    }
  })

export type GatewayConfig = z.infer<typeof GatewayConfig>
export type PeerConfig = GatewayConfig['peers'][number]

export const configFile = (dir: string) => path.join(dir, 'gateway.json')

/** The config, or a clear error naming the field: a gateway never runs on a config it cannot read. */
export const readConfig = (dir: string): GatewayConfig => {
  const file = configFile(dir)
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const r = GatewayConfig.safeParse(raw)
  if (!r.success) throw new Error(`${file}: ${r.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`)
  return r.data
}

/** The roles this peer's (human, role) may START a conversation with. Default: none. */
export const exposedTo = (cfg: GatewayConfig, domain: string, human: string, role: string): string[] =>
  cfg.peers.find((p) => p.domain === domain)?.expose.filter((e) => e.human === human && e.role === role).flatMap((e) => e.roles) ?? []

/** Every role exposed to a peer domain, for the exposure list it is sent (roles only, never nodes). */
export const exposedToDomain = (cfg: GatewayConfig, domain: string): string[] =>
  [...new Set(cfg.peers.find((p) => p.domain === domain)?.expose.flatMap((e) => e.roles) ?? [])].sort()
