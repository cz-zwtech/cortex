/**
 * Sessions talk to the telegram service over comms: a command is a message to the service's
 * role whose body is JSON, `{"command": "<verb>", ...}`. The sender's identity is
 * the role its node labelled the message with, not anything in the body, which
 * is what closes the earlier gateway's D5 (any loopback holder of the session token could
 * act as any session).
 *
 * The result goes back to the sender as JSON, echoing the command's `nonce`
 * (ids differ on each node, so the nonce is what pairs a reply with its command). Anything holding operator or
 * producer text (an item's body, a reply's text) goes as a FILE through the
 * mesh file transfer, never in a body: secret-gated, never executed, and read
 * by the session as data.
 */
import fs from 'node:fs'
import path from 'node:path'

import { Rejected, type Gateway } from './gateway.js'

export type CommandMessage = { id: string; from: string; body: string }

export interface CommandPort {
  inbox(): Promise<CommandMessage[]>
  markSeen(ids: string[]): void
  reply(to: string, body: string, files?: string[]): Promise<boolean>
}

/** `node-b:pm/pm` or `pm/pm-1` -> `pm`. */
export const roleOf = (from: string): string | undefined => {
  const local = from.includes(':') ? from.slice(from.indexOf(':') + 1) : from
  const role = local.split('/')[0]
  return role && /^[a-z][a-z0-9-]*$/.test(role) ? role : undefined
}

export const VERBS = ['health', 'show', 'ack', 'retry', 'send', 'replies', 'claim', 'digest', 'reviewed'] as const

const run = async (gw: Gateway, role: string, c: Record<string, unknown>, outDir: string): Promise<{ result: unknown; files?: string[] }> => {
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : undefined)
  const asFile = (name: string, data: unknown) => {
    fs.mkdirSync(outDir, { recursive: true })
    const f = path.join(outDir, name)
    fs.writeFileSync(f, JSON.stringify(data, null, 1) + '\n')
    return f
  }
  switch (c.command) {
    case 'health':
      return { result: gw.health(true) }
    case 'show': {
      const item = gw.show(str('item') ?? '')
      return { result: { item: item.id, state: item.state, file: `item-${item.id}.json` }, files: [asFile(`item-${item.id}.json`, item)] }
    }
    case 'ack':
      return { result: await gw.ack(str('item') ?? '', role, str('resolution') ?? '', str('note')) }
    case 'retry':
      return { result: str('outbound') ? await gw.retryOutbound(str('outbound')!) : await gw.retryItem(str('item') ?? '') }
    case 'send':
      return { result: await gw.send({ bot: str('bot'), sender: role, text: c.text, component: c.component, topic: c.topic, idempotencyKey: c.idempotency_key, to: c.to, replyTo: c.reply_to }) }
    case 'replies': {
      const rows = gw.replies({ bot: c.bot, id: c.id, owner: c.owner, topic: c.topic, since: c.since })
      const name = `replies-${Date.now()}.json`
      return { result: { count: rows.length, ids: rows.map((r) => r.id), at: rows.map((r) => r.at), file: rows.length ? name : undefined }, files: rows.length ? [asFile(name, rows)] : undefined }
    }
    case 'claim':
      return { result: gw.claim(c.id, role) }
    case 'digest':
      return { result: { unreviewed_info: gw.digest() } }
    case 'reviewed':
      return { result: gw.markReviewed(c.ids, role) }
    default:
      throw new Rejected(`unknown telegram command; one of ${VERBS.join(', ')}`)
  }
}

/** Handle every waiting command once. Each gets exactly one reply, ok or error, carrying its ref. */
export const handleCommands = async (gw: Gateway, port: CommandPort, outDir: string, log: (m: string) => void): Promise<number> => {
  const items = await port.inbox()
  for (const m of items) {
    port.markSeen([m.id])
    let parsed: Record<string, unknown> | undefined
    try {
      const v = JSON.parse(m.body)
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.command === 'string') parsed = v
    } catch {
      /* not a command: ignored, as a person's chatter in the role would be */
    }
    if (!parsed) continue
    const role = roleOf(m.from)
    let reply: Record<string, unknown>
    let files: string[] | undefined
    try {
      if (!role) throw new Rejected(`cannot tell the sender's role from ${JSON.stringify(m.from)}`, 403)
      const r = await run(gw, role, parsed, path.join(outDir, m.id.replace(/[^A-Za-z0-9._-]/g, '_')))
      reply = { commandResult: { ref: m.id, nonce: parsed.nonce, ok: true, result: r.result } }
      files = r.files
    } catch (err) {
      const status = err instanceof Rejected ? err.status : 500
      if (!(err instanceof Rejected)) log(`command ${String(parsed.command)}: ${err instanceof Error ? err.message : err}`)
      reply = { commandResult: { ref: m.id, nonce: parsed.nonce, ok: false, status, error: err instanceof Rejected ? err.message : 'internal error' } }
    }
    if (!(await port.reply(m.from, JSON.stringify(reply), files).catch(() => false))) log(`could not reply to ${m.from} for ${m.id}`)
    // Sending snapshots the files, so the working copies can go now.
    if (files) fs.rmSync(path.dirname(files[0]!), { recursive: true, force: true })
  }
  return items.length
}
