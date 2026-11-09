/**
 * What the mesh daemon needs from comms, kept here so the daemon never
 * interprets comms records itself:
 *
 *   localRoles    the roles this node announces: those with a member who
 *                 joined here, with each member's capabilities, focus and
 *                 whether it is live, so other nodes can tell who is around
 *   acceptRouted  whether a routed message may land in a mailbox here
 *   notifySender  tell a sender here that a routed message was refused
 */
import { recordBus } from './dialogue.js'
import { decode, encode } from './envelope.js'
import { foldRegistry, lastBeats, liveRole } from './registry.js'
import { ADDR } from './transport.js'
import type { MeshLog } from './mesh/log.js'
import { NodeTable, type AnnouncedRole } from './mesh/nodes.js'
import type { Accept, DeliverFiles, OutboxRow } from './mesh/router.js'

export const localRegistry = (log: MeshLog) =>
  foldRegistry(log.read(ADDR.registry).filter((r) => r.origin === log.origin).flatMap((r) => decode(`${r.origin}.${r.seq}`, r.payload) ?? []))

const localBeats = (log: MeshLog) =>
  lastBeats(log.read(ADDR.beat).filter((r) => r.origin === log.origin).flatMap((r) => decode(`${r.origin}.${r.seq}`, r.payload) ?? []))

/** Comms' own live window (comms.ts DEFAULT_LIVE_MS), read here without importing the client. */
const liveWindowMs = () => Number(process.env.CKN_COMMS_LIVE_MS ?? 15 * 60_000)

export const localRoles = (log: MeshLog, now: () => number = Date.now) => (): AnnouncedRole[] => {
  const reg = localRegistry(log)
  const beats = localBeats(log)
  const live = (name: string) => now() - (beats.get(name) ?? 0) <= liveWindowMs()
  return [...reg.roles.values()]
    .filter((r) => !r.deleted && r.members.size > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({
      role: r.name,
      members: [...r.members].sort().map((name) => {
        const meta = reg.members.get(name)?.meta ?? {}
        return {
          name,
          ...(meta.cap ? { capabilities: String(meta.cap) } : {}),
          ...(meta.focus ? { focus: String(meta.focus) } : {}),
          ...(live(name) ? { live: true as const } : {}),
        }
      }),
    }))
}

/**
 * A routed message lands only in a mailbox that exists here: a live role, or
 * a member who holds one. Anything else is refused back to the sender, never
 * stored where nobody reads it.
 */
export const acceptRouted = (log: MeshLog): Accept => (address, body, from) => {
  const env = decode('routed', body)
  if (!env || env.type !== 'msg') return { ok: false, reason: 'not a comms message' }
  // Trust rests on origin (no auth inside): a foreign record counts only when this mesh's gateway wrote it.
  if (env.foreign) {
    const gateway = new NodeTable(log.db).list().some((n) => n.node === from && n.intent === 'gateway')
    if (!gateway) {
      console.error(`comms: dropped a foreign-stamped record from ${from}, which is not a gateway`)
      return { ok: false, reason: 'foreign records are accepted only from a gateway' }
    }
    if (!env.notify) return { ok: false, reason: 'a foreign record must arrive as data (notify)' }
  }
  const reg = localRegistry(log)
  if (address.startsWith(ADDR.role(''))) {
    const role = address.slice(ADDR.role('').length)
    if (!liveRole(reg, role)) return { ok: false, reason: `no role ${role} on ${log.origin}` }
    recordBus('receive', env, `role:${role}`)
    return { ok: true }
  }
  if (address.startsWith(ADDR.member(''))) {
    const member = address.slice(ADDR.member('').length)
    if (!reg.members.get(member)?.roles.size) return { ok: false, reason: `no member ${member} on ${log.origin}` }
    recordBus('receive', env, member)
    return { ok: true }
  }
  return { ok: false, reason: 'not a comms mailbox' }
}

/** The gateway's word for an outbound record its sanitizer stopped. */
export const HELD = 'held for review'

/** A message from here could not be delivered: a notice in its sender's own mailbox. */
export const notifySender = (log: MeshLog) => (row: OutboxRow, envelope: string, reason: string) => {
  const sent = decode('outbox', envelope)
  if (!sent) return
  const member = sent.from.includes('/') ? sent.from.split('/')[1]! : sent.from
  // A hold exists because the text may carry a secret: quoting it back would keep it in the mailbox store and transcripts.
  const body =
    reason === HELD || reason.endsWith(`: ${HELD}`)
      ? `your message to ${sent.to ?? row.to_node} was held for review (your message id ${row.id})`
      : `your message ${row.id} to ${sent.to ?? row.to_node} was not delivered: ${reason}. It said: ${(sent.body ?? '').slice(0, 160)}`
  log.append('comms', ADDR.member(member), encode({ v: 1, type: 'msg', stamp: Date.now(), from: 'cortex-mesh', to: member, ref: row.id, body }))
}

/** Files arrived and verified: the message that came with them, now saying where they are. */
export const deliverFiles = (log: MeshLog): DeliverFiles => (address, body, saved) => {
  const env = decode('routed', body)
  if (!env) throw new Error('not a comms message')
  const r = log.append('comms', address, encode({ ...env, files: saved.map((f) => ({ name: f.name, path: f.path, size: f.size, sha256: f.sha256 })) }))
  return `${r.origin}.${r.seq}`
}

/** How long a delivered message may sit unread before its sender hears that nobody there is listening. */
export const UNSEEN_AFTER_MS = Number(process.env.CKN_COMMS_UNSEEN_AFTER_MS ?? 10 * 60_000)

/**
 * A routed message delivered while its target looked live can still sit
 * unseen: the watcher lapsed after it landed. Today the sender hears "nobody
 * listening" only at send time (19 Oct leftover, B.5). Once a delivered message
 * has waited unread past UNSEEN_AFTER_MS and no member at its address is live
 * by the target node's announcement, its sender is told, once.
 */
export const unseenNotices = (log: MeshLog, now = Date.now()): number => {
  log.db.exec('CREATE TABLE IF NOT EXISTS comms_unseen (id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
  let rows: OutboxRow[]
  try {
    rows = log.db
      .prepare(
        `SELECT * FROM outbox WHERE delivered_at IS NOT NULL AND read_at IS NULL AND failed IS NULL AND delivered_at < ?
           AND id NOT IN (SELECT id FROM comms_unseen)`,
      )
      .all(now - UNSEEN_AFTER_MS) as OutboxRow[]
  } catch {
    return 0 // no daemon has run here yet: no outbox
  }
  const nodes = new NodeTable(log.db)
  let told = 0
  for (const row of rows) {
    const role = row.address.startsWith(ADDR.role('')) ? row.address.slice(ADDR.role('').length) : undefined
    const member = row.address.startsWith(ADDR.member('')) ? row.address.slice(ADDR.member('').length) : undefined
    if (!role && !member) continue // a gateway's mailbox: the peer's own acks say how it fares
    const target = nodes.get(row.to_node)
    if (!target) continue
    const live = role
      ? target.members.find((r) => r.role === role)?.members.some((m) => m.live)
      : target.members.flatMap((r) => r.members).find((m) => m.name === member)?.live
    if (live) continue
    const seq = Number(row.id.slice(row.id.lastIndexOf('.') + 1))
    const rec = log.db.prepare("SELECT payload FROM records WHERE origin = ? AND seq = ? AND kind = 'route-out'").get(log.origin, seq) as { payload: string } | undefined
    const sent = rec ? decode('outbox', (JSON.parse(rec.payload) as { body: string }).body) : null
    log.db.prepare('INSERT OR IGNORE INTO comms_unseen (id, at) VALUES (?, ?)').run(row.id, now)
    if (!sent) continue
    const where = `${target.alias ?? target.node}:${role ?? member}`
    const who = memberOfFrom(sent.from)
    const mins = Math.round((now - row.delivered_at!) / 60_000)
    log.append(
      'comms',
      ADDR.member(who),
      encode({ v: 1, type: 'msg', stamp: now, from: 'cortex-mesh', to: who, ref: row.id, body: `your message ${row.id} to ${where} was delivered ${mins} min ago and is still unseen: nobody at ${where} is listening now, so it waits until someone is back` }),
    )
    told++
  }
  return told
}

const memberOfFrom = (from: string) => (from.includes('/') ? from.split('/')[1]! : from)
