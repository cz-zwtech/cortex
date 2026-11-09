/**
 * telegram.json: the module's settings, in its data dir. The module has no
 * built-in bot: an install names each bot it may use, by the identity Telegram
 * must report for it (getMe), where its token comes from (a secret reference,
 * secrets.ts), and the operators' chats. A mismatch refuses the bot. No secret
 * value is ever written here; a token-shaped value is refused.
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import { LITERAL_TOKEN, SecretRef } from './secrets.js'

export const SEVERITIES = ['info', 'action', 'page'] as const
export type Severity = (typeof SEVERITIES)[number]

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)

const Route = z.object({
  /** Matched case-insensitively at the start of the operator's message, e.g. "note ". */
  prefix: z.string().min(1).max(40),
  to: z.union([z.object({ role: Slug }).strict(), z.object({ event: z.literal('telegram.inbound') }).strict()]),
}).strict()

const Bot = z
  .object({
    id: Slug,
    default: z.boolean().default(false),
    channel: z.literal('telegram').default('telegram'),
    mode: z.enum(['live', 'dry-run']).default('live'),
    poll: z.boolean().default(false),
    /** The username Telegram reports for this bot (getMe). Anything else is refused. */
    identity: z.object({ username: z.string().regex(/^@?[A-Za-z0-9_]{5,32}$/) }).strict(),
    /** Where the bot's token comes from. Never the token. */
    token: SecretRef,
    /** Who may talk to this bot, and the only chats it sends to. A private chat's id is its person's id. */
    operators: z.array(z.object({ name: Slug, chat: SecretRef }).strict()).min(1),
    /** The operator who gets fallbacks and alerts. */
    fallbackTo: Slug,
    /** Minutes from intake. Info has no entry: it is never sent to the operator (28 Sep 2026). */
    fallbackMinutes: z.object({ page: z.number().positive().optional(), action: z.number().positive().optional() }).strict().default({ page: 5, action: 30 }),
    /** Roles that may send through this bot; '*' for any known sender. */
    senders: z.array(z.union([z.literal('*'), Slug])).default(['*']),
    routes: z.array(Route).default([]),
    tags: z.array(z.object({ pattern: z.string().min(1), defaultOwner: Slug }).strict()).default([]),
    /** systemd user units that must not be running while this bot polls (one getUpdates per token). */
    conflictingUnits: z.array(z.string().regex(/^[A-Za-z0-9@._-]+\.service$/)).default([]),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (!b.operators.some((o) => o.name === b.fallbackTo)) ctx.addIssue({ code: 'custom', message: `bot ${b.id}: fallbackTo ${b.fallbackTo} is not one of its operators` })
    if (b.poll && b.mode !== 'live') ctx.addIssue({ code: 'custom', message: `bot ${b.id}: poll needs mode live` })
  })

export const ConfigSchema = z
  .object({
    tickSeconds: z.number().positive().default(2),
    /** The comms member this service sends as and reads commands for (cortex-install --service joins it). */
    member: z.string().regex(/^[a-z][a-z0-9-]*$/).default('telegram-1'),
    http: z
      .object({
        listen: z.array(z.string().regex(/^[0-9a-fA-F.:]+:\d+$/)).default(['127.0.0.1:7320']),
        /** The token a local client publishes items with. Required when anything listens. */
        publishToken: SecretRef.optional(),
      })
      .strict()
      .default({}),
    owners: z
      .object({
        known: z.array(Slug).default([]),
        /** A role on more than one node, fixed to one: { "globex-dev": "node-a:globex-dev" }. */
        pin: z.record(Slug, z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*:[a-z][a-z0-9-]*$/)).default({}),
      })
      .strict()
      .default({}),
    bots: z.array(Bot).min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.http.listen.length && !c.http.publishToken) ctx.addIssue({ code: 'custom', message: 'http.publishToken: required while http.listen is set (or set listen to [])' })
    const ids = c.bots.map((b) => b.id)
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'bot ids must be unique' })
    if (c.bots.filter((b) => b.default).length > 1) ctx.addIssue({ code: 'custom', message: 'at most one bot is the default' })
  })

export type Config = z.infer<typeof ConfigSchema>
export type BotConfig = Config['bots'][number]

export const configFile = (dataDir: string) => path.join(dataDir, 'telegram.json')

/** Parse and check; a message names every problem. Info fallbacks are refused by the schema (strict). */
/** The shape before explicit configuration (31 Oct): env names, no identity. */
const OLD_SHAPE = (raw: unknown) => JSON.stringify(raw).includes('"tokenEnv"') || JSON.stringify(raw).includes('"chatEnv"') || JSON.stringify(raw).includes('"publishTokenEnv"')

export const parseConfig = (raw: unknown): Config => {
  if (LITERAL_TOKEN.test(JSON.stringify(raw))) throw new Error('telegram.json holds a bot token: name where it comes from instead (token: { from: "bao", path, key })')
  if (OLD_SHAPE(raw)) throw new Error('telegram.json is in the old shape (tokenEnv/chatEnv): run cortex-telegram-admin migrate')
  const r = ConfigSchema.safeParse(raw)
  if (!r.success) throw new Error(`telegram.json: ${r.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`)
  return r.data
}

export const loadConfig = (dataDir: string): Config | undefined => {
  const file = configFile(dataDir)
  if (!fs.existsSync(file)) return undefined
  return parseConfig(JSON.parse(fs.readFileSync(file, 'utf-8')))
}

export const defaultBot = (c: Config): BotConfig => c.bots.find((b) => b.default) ?? c.bots[0]!
