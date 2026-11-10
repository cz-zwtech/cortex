#!/usr/bin/env tsx
/**
 * cortex-telegram: a session's way to the telegram service, from any node.
 *
 *   health
 *   show <item>                                     the item, as a file (its text is producer data)
 *   ack <item> --handled | --forward [--note <text>]
 *   retry <item> | retry --outbound <id>
 *   send [--topic T] [--component C] [--bot B] [--to OPERATOR] [--idempotency-key K] [--reply-to INBOUND] [--file F]
 *                                                   text from stdin or --file, never argv
 *   replies [--id N] [--owner R] [--topic T] [--since ISO] [--bot B]
 *   await [--topic T] [--owner R] [--since ISO] [--timeout S] [--interval S]
 *                                                   the FIRST reply after --since (default: now);
 *                                                   exit 0 with it, 2 on timeout
 *   claim <inbound id>                              exit 0 if won, 1 if lost
 *   digest [--mark-reviewed ID ...]
 *
 * Each verb is one command message to the service's role (CKN_TELEGRAM_ADDRESS,
 * default the bare role telegram), sent as this session's member; the service acts as
 * this session's ROLE, which its node labels, not anything said here. Output
 * is JSON. Files holding operator or producer text arrive in this member's
 * inbox folder and are printed from there, as data.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { EventBus } from '../../../core/events.js'
import { Lifecycle } from '../../../core/lifecycle.js'
import { dataRoot, dbPath, modulesDir } from '../../../core/paths.js'
import { Storage } from '../../../core/storage.js'
import { recordReceived, recordSent } from '../server/dialogue.js'
import { exitOnHelp } from '../../../core/help.js'

exitOnHelp(`usage: cortex-telegram <command>
  health | show <item> | ack <item> --handled|--forward [--note <text>] | retry <item> | retry --outbound <id>
  send [--topic T] [--component C] [--bot B] [--to OPERATOR] [--idempotency-key K] [--reply-to INBOUND] [--file F]
       text from stdin or --file, never argv
  replies [--id N] [--owner R] [--topic T] [--since ISO] [--bot B]
  await [--topic T] [--owner R] [--since ISO] [--timeout S] [--interval S]
  claim <inbound id> | digest [--mark-reviewed ID ...]`)

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const bool = (name: string): boolean => {
  const i = args.indexOf(name)
  if (i < 0) return false
  args.splice(i, 1)
  return true
}
const out = (v: unknown) => console.log(JSON.stringify(v, null, 1))
const die = (msg: string, code = 1): never => {
  out({ error: msg })
  process.exit(code)
}

const address = process.env.CKN_TELEGRAM_ADDRESS ?? 'telegram'
const asName = flag('--as')
const timeoutS = Number(flag('--timeout') ?? 0)
const intervalS = Number(flag('--interval') ?? 15)
// Comms through its capabilities, as every CLI gets them (the modules started here; never the host-only ones).
const storage = new Storage(dbPath())
const lc = new Lifecycle({ modulesDir: modulesDir(), dataRoot: dataRoot(), dbPath: storage.path, events: new EventBus(), storage, log: () => {} })
await lc.run()
const cap = <T>(id: string): T => lc.capabilities.get<T>(id) ?? die(`${id} is not available: is comms installed?`)
type Inbox = { id: string; from: string; body: string; files?: { name: string; path: string }[] }[]
const comms = {
  send: cap<(from: string, to: string, body: string, opts?: { queueAnyway?: boolean }) => Promise<{ ok: boolean; id?: string; outcome?: string }>>('comms.send'),
  inbox: cap<(member: string, opts?: { silent?: boolean }) => Promise<Inbox>>('comms.inbox'),
  markSeen: cap<(member: string, ids: string[]) => void>('comms.markSeen'),
}
const local = { markAwait: cap<(member: string, key: string, state: 'reminded' | 'answered') => void>('comms.markAwait') }
const sessionRoles = cap<(session: string) => Promise<{ bound: boolean; member?: string }>>('comms.sessionRoles')
const session = process.env.CLAUDE_CODE_SESSION_ID
const member = asName ?? (session ? (await sessionRoles(session)).member : undefined)
if (!member) die('this session is not a member of any role; join one first (cortex-role join <role>)')

type Result = { ok: boolean; result?: Record<string, unknown>; error?: string; status?: number; files?: string[] }

/** One command, one reply: send, then watch this member's inbox for the reply carrying our nonce. */
const call = async (command: Record<string, unknown>, waitS = 90): Promise<Result> => {
  const nonce = crypto.randomBytes(8).toString('hex')
  const sent = await comms.send(member!, address, JSON.stringify({ ...command, nonce }), { queueAnyway: true })
  if (!sent.ok) die(`could not reach ${address}: ${sent.outcome}`)
  const end = Date.now() + waitS * 1000
  while (Date.now() < end) {
    for (const item of await comms.inbox(member!, { silent: true })) {
      let r: { commandResult?: Result & { nonce?: string } } | undefined
      try {
        r = JSON.parse(item.body)
      } catch {
        continue
      }
      if (r?.commandResult?.nonce !== nonce) continue
      comms.markSeen(member!, [item.id])
      return { ...r.commandResult, files: item.files?.flatMap((f) => (f.path ? [f.path] : [])) }
    }
    await new Promise((res) => setTimeout(res, 500))
  }
  return die(`no answer from ${address} within ${waitS} s; the command may still run (the command is held until delivered)`)
}

/** Operator text that reached this session is dialogue the session took part in. */
const recordRows = (data: unknown[]) => {
  for (const d of data) if (Array.isArray(d)) recordReceived(member!, d as Record<string, unknown>[])
}

const show = (r: Result, exitOnError = true, received = false) => {
  if (!r.ok) {
    out({ error: r.error, status: r.status })
    if (exitOnError) process.exit(1)
    return
  }
  const data = (r.files ?? []).map((f) => JSON.parse(fs.readFileSync(f, 'utf-8')) as unknown)
  if (received) recordRows(data)
  out(data.length ? { ...r.result, data: data.length === 1 ? data[0] : data } : r.result)
}

const [verb, ...rest] = args
switch (verb) {
  case 'health':
    show(await call({ command: 'health' }))
    break
  case 'show':
    show(await call({ command: 'show', item: rest[0] ?? die('usage: show <item>') }))
    break
  case 'ack': {
    const handled = bool('--handled')
    const forward = bool('--forward')
    if (handled === forward) die('usage: ack <item> --handled | --forward [--note <text>]')
    show(await call({ command: 'ack', item: rest[0], resolution: handled ? 'handled' : 'forward', note: flag('--note') }))
    break
  }
  case 'retry': {
    const outbound = flag('--outbound')
    show(await call(outbound ? { command: 'retry', outbound } : { command: 'retry', item: rest[0] ?? die('usage: retry <item> | --outbound <id>') }))
    break
  }
  case 'send': {
    const file = flag('--file')
    const text = (file ? fs.readFileSync(file, 'utf-8') : fs.readFileSync(0, 'utf-8')).trim()
    if (!text) die('empty text: pass it on stdin or with --file')
    const replyTo = flag('--reply-to')
    const to = flag('--to')
    const bot = flag('--bot')
    const r = await call({ command: 'send', text, topic: flag('--topic'), component: flag('--component'), bot, to, idempotency_key: flag('--idempotency-key'), reply_to: replyTo })
    // Answered: the Stop reminder for that operator message is done on this node.
    if (r.ok && replyTo) local.markAwait(member!, `telegram:${replyTo}`, 'answered')
    if (r.ok) recordSent(member!, text, { to, replyTo, bot, outboundId: r.result?.id !== undefined ? String(r.result.id) : undefined })
    show(r)
    break
  }
  case 'replies':
    show(await call({ command: 'replies', id: flag('--id'), owner: flag('--owner'), topic: flag('--topic'), since: flag('--since'), bot: flag('--bot') }), true, true)
    break
  case 'await': {
    // The first match after --since; without it, only replies that arrive from now on (addition C).
    const since = flag('--since') ?? new Date().toISOString()
    const q = { command: 'replies', owner: flag('--owner'), topic: flag('--topic'), since, bot: flag('--bot') }
    const end = Date.now() + (timeoutS || 3600) * 1000
    for (;;) {
      const r = await call(q)
      if (!r.ok) show(r)
      const rows = (r.files?.length ? (JSON.parse(fs.readFileSync(r.files[0]!, 'utf-8')) as unknown[]) : []) as Record<string, unknown>[]
      if (rows.length) {
        recordReceived(member!, rows.slice(0, 1))
        out({ status: 'reply', ...rows[0] })
        process.exit(0)
      }
      if (Date.now() >= end) {
        out({ status: 'timeout' })
        process.exit(2)
      }
      await new Promise((res) => setTimeout(res, intervalS * 1000))
    }
  }
  case 'claim': {
    const r = await call({ command: 'claim', id: rest[0] ?? die('usage: claim <inbound id>') })
    show(r)
    process.exit(r.result?.won ? 0 : 1)
  }
  case 'digest': {
    const i = args.indexOf('--mark-reviewed')
    if (i >= 0) show(await call({ command: 'reviewed', ids: args.slice(i + 1) }))
    else show(await call({ command: 'digest' }))
    break
  }
  default:
    die('usage: cortex-telegram health | show | ack | retry | send | replies | await | claim | digest (see the header of modules/telegram/bin/cortex-telegram.ts)', 2)
}
process.exit(0)
