/**
 * The running gateway, inside the mesh daemon of a node with intent `gateway`.
 * It owns the external links and everything that crosses them.
 *
 *   outbound  a home session writes to `<domain>:<role>`; comms routes it to this
 *             node's mailbox `gate:<domain>:<role>`. accept() checks the peer
 *             announced the role (or wrote to us from it) and runs the sanitizer:
 *             a hold is refused there, so the sender hears "held for review" and
 *             nothing is stored. What is accepted is signed and sent on, and the
 *             sender's role gets a return path. When the peer says READ, the
 *             sender's node is told READ, and its copy goes.
 *   inbound   a signed record from a peer is checked: its key, its kind (never an
 *             action), then exposure or an open return path. It is handed to the
 *             home node holding the role as a routed message of which this node is
 *             the ORIGIN, framed as foreign data, and held until READ there.
 *
 * Every crossing, admitted, held or refused, goes to the audit chain.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  ACKS_ADDRESS,
  ADDR,
  chunksOf,
  decode,
  encode,
  EXTERNAL_ADDRESS,
  HELD,
  NodeTable,
  OUTBOX_ADDRESS,
  safeName,
  sha256,
  type Accept,
  type Envelope,
  type ExternalNotice,
  type FileEntry,
  type MeshLog,
  type RouteOut,
} from '../../comms/server/api.js'
import { scanForSecrets } from '../../../core/secrets.js'
import { Audit, payloadHash, verifyAudit } from './audit.js'
import { exposedTo, exposedToDomain, readConfig, type GatewayConfig } from './config.js'
import { ExternalLinks, type Frame } from './external.js'
import { loadDomainKey, sign, verify } from './keys.js'
import { Crossings, renderMetrics, writeMetrics } from './metrics.js'
import { sanitize } from './sanitize.js'
import { writeGatewayStatus } from './status.js'
import { GatewayStore } from './store.js'

export const GATE_PREFIX = 'gate:'
export const GATE_CONTROL = 'gate-ctl:close:'
/** Communication only. home never accepts actions (trust doc 3, 3a). */
export const COMM_KINDS = ['message', 'question', 'answer'] as const
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_BODY = 32_000
/**
 * Files cross inline in the signed record, so the signature covers them; inside each domain they move
 * by the mesh's chunked routing. One message carries at most this much.
 */
export const GATE_FILES_MAX = 8 * 1024 * 1024
const RESEND_MS = 30_000
const EXPOSE_MS = 30_000
const VERIFY_MS = 10 * 60_000

/** What the gateway needs from the mesh daemon it runs in. Absent: links only (slice 1). */
export type MeshHooks = {
  log: MeshLog
  /** Nodes with a route now. */
  reachable: () => Set<string>
}

export type GatewayDeps = {
  /** The gateway's data dir (gateway.json, the domain key, its state). */
  dir: string
  log?: (msg: string) => void
  mesh?: MeshHooks
}

export type Gateway = {
  config: () => GatewayConfig
  links: ExternalLinks
  store: GatewayStore
  /** The mesh's accept for `gate:` and `gate-ctl:` mailboxes on this node. */
  accept: Accept
  /** The sanitizer for a file bound out of the domain, as the mesh's file gate for gate mailboxes. */
  scanFile: (file: string, address: string) => string | undefined
  /** One pass: take what home accepted here, send what is due, ack what home read. */
  pump: () => void
  close: () => Promise<void>
}

type XMsg = {
  t: 'xmsg'
  id: string
  kind: string
  from: { domain: string; human: string; role: string; member?: string }
  to: { domain: string; role: string }
  body: string
  files?: XFile[]
  at: number
  sig?: string
}
type XFile = { name: string; size: number; sha256: string; data: string }

const isXFiles = (v: unknown): v is XFile[] =>
  Array.isArray(v) &&
  v.length <= 64 &&
  v.every((f) => !!f && typeof f.name === 'string' && safeName(f.name) && Number.isInteger(f.size) && f.size >= 0 && /^[0-9a-f]{64}$/.test(f.sha256) && typeof f.data === 'string')
/** Text files are scanned; a binary one (a NUL in its start) cannot hold a pasted key the scanner would read. */
const isBinary = (b: Buffer) => b.subarray(0, 8192).includes(0)

const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const isXMsg = (f: Frame): f is Frame & XMsg => {
  const x = f as unknown as XMsg
  return (
    str(x.id) && str(x.kind, 40) && typeof x.body === 'string' && typeof x.at === 'number' &&
    !!x.from && str(x.from.domain) && str(x.from.human, 64) && str(x.from.role, 64) && (x.from.member === undefined || str(x.from.member, 64)) &&
    !!x.to && str(x.to.domain) && str(x.to.role, 64) &&
    (x.files === undefined || isXFiles(x.files))
  )
}
const roleOf = (from: string) => from.split('/')[0]!
const memberOf = (from: string) => (from.includes('/') ? from.split('/')[1]! : from)
/** `gate:<domain>:<role>` and `gate-ctl:close:<domain>:<role>`: a domain never holds a colon. */
const target = (address: string, prefix: string) => {
  const rest = address.slice(prefix.length)
  const i = rest.indexOf(':')
  return i > 0 ? { domain: rest.slice(0, i), role: rest.slice(i + 1) } : undefined
}

export const startGateway = async (deps: GatewayDeps): Promise<Gateway> => {
  const say = deps.log ?? ((m: string) => console.error(`gateway: ${m}`))
  let cfg = readConfig(deps.dir)
  // The config is re-read when it changes on disk, so an exposure edit needs no restart; a bad edit keeps the last good one.
  let mtime = fs.statSync(`${deps.dir}/gateway.json`).mtimeMs
  const config = () => {
    try {
      const m = fs.statSync(`${deps.dir}/gateway.json`).mtimeMs
      if (m !== mtime) {
        mtime = m
        cfg = readConfig(deps.dir)
        say('gateway.json reloaded')
      }
    } catch (err) {
      say(`gateway.json not reloaded, keeping the last good config: ${err instanceof Error ? err.message : String(err)}`)
    }
    return cfg
  }
  const key = loadDomainKey(deps.dir)
  const store = new GatewayStore(deps.dir)
  const crossings = new Crossings(deps.dir)
  const audit = new Audit(deps.dir, (e) => crossings.count(e))
  // The chain is walked at start and every ten minutes; a break shows in status and as cortex_gateway_audit_ok 0.
  let chain: ReturnType<typeof verifyAudit> = verifyAudit(deps.dir)
  if (!chain.ok) say(`the audit chain is broken at line ${chain.line}: ${chain.why}`)
  const mesh = deps.mesh
  const peerOf = (domain: string) => config().peers.find((p) => p.domain === domain)

  // ── home side ─────────────────────────────────────────────────────────────

  /** The home node holding a role: a reachable one first. */
  const nodeOfRole = (role: string, reachableOnly = false): string | undefined => {
    if (!mesh) return undefined
    const up = mesh.reachable()
    const holders = new NodeTable(mesh.log.db)
      .list()
      .filter((n) => n.intent === 'node' && n.members.some((r) => r.role === role && r.members.length > 0))
      .map((n) => n.node)
    return holders.find((n) => up.has(n)) ?? (reachableOnly ? undefined : holders[0])
  }

  /** Route a comms message from this node to a home node; this node is its origin and holds it until READ. */
  const routeHome = (to: string, address: string, env: Envelope, files?: RouteOut['files']) =>
    mesh!.log.append('route-out', OUTBOX_ADDRESS, JSON.stringify({ to, address, body: encode(env), ...(files ? { files } : {}) } satisfies RouteOut), '', env.stamp)

  /** Tell a home sender something, in its member mailbox. */
  const tellHome = (node: string, sender: string, body: string) =>
    routeHome(node, ADDR.member(memberOf(sender)), { v: 1, type: 'msg', stamp: Date.now(), from: 'cortex-gateway', to: memberOf(sender), body })

  /**
   * Home's message here is finished with: its origin is told READ, or FAILED with the reason (its sender
   * then gets the router's not-delivered notice), and its body leaves this node.
   */
  const finishLocal = (localId: string, refused?: string) => {
    if (refused) mesh!.log.append('route-refuse', ACKS_ADDRESS, JSON.stringify({ local: localId, reason: refused }))
    else mesh!.log.append('route-ack', ACKS_ADDRESS, JSON.stringify({ local: [localId] }))
    const seq = Number(localId.slice(localId.lastIndexOf('.') + 1))
    mesh!.log.db.prepare("DELETE FROM records WHERE origin = ? AND seq = ? AND kind = 'comms'").run(mesh!.log.origin, seq)
  }

  const scanFile = (file: string, address: string): string | undefined => {
    const t = target(address, GATE_PREFIX)
    let data: Buffer
    try {
      data = fs.readFileSync(file)
    } catch {
      return HELD
    }
    if (isBinary(data)) return undefined
    const verdict = sanitize(data.toString('utf-8'), config().denyList)
    if (verdict.ok) return undefined
    audit.write({ dir: 'out', peer: t?.domain ?? address, decision: 'held', rule: `file: ${verdict.rule}`, payloadHash: payloadHash(data.toString('base64')) })
    return HELD
  }

  const accept: Accept = (address, body, from) => {
    const env = decode('gate', body)
    if (!env || env.type !== 'msg') return { ok: false, reason: 'not a comms message' }
    if (address.startsWith(GATE_CONTROL)) {
      const t = target(address, GATE_CONTROL)
      return t && env.from.includes('/') ? { ok: true } : { ok: false, reason: 'close-return needs <domain>:<role> and a sender with a role' }
    }
    const t = address.startsWith(GATE_PREFIX) ? target(address, GATE_PREFIX) : undefined
    if (!t) return { ok: false, reason: 'not a gateway mailbox' }
    const principal = env.from
    const refuse = (rule: string, reason = rule) => {
      audit.write({ dir: 'out', peer: t.domain, principal, decision: 'refused', rule, payloadHash: payloadHash(env.body ?? '') })
      return { ok: false as const, reason }
    }
    if (!peerOf(t.domain)) return refuse(`no peer ${t.domain} on this gateway`)
    if (!env.from.includes('/')) return refuse('the sender holds no role', 'a message out of this domain must come from a role')
    const announced = store.peerRoles().find((p) => p.peer === t.domain)?.roles ?? []
    if (!announced.includes(t.role) && !store.hasHeard(t.domain, t.role)) return refuse(`${t.domain} has not announced ${t.role}`)
    const bytes = (env.files ?? []).reduce((n, f) => n + f.size, 0)
    if (bytes > GATE_FILES_MAX) return refuse(`files over ${GATE_FILES_MAX / 1048576} MB cannot cross the gateway`)
    const verdict = sanitize(env.body ?? '', config().denyList)
    if (!verdict.ok) {
      // The sender hears only "held for review": the reason may be the sensitive part.
      audit.write({ dir: 'out', peer: t.domain, principal, decision: 'held', rule: verdict.rule, payloadHash: payloadHash(env.body ?? '') })
      say(`held a message from ${principal} (node ${from}) to ${t.domain}:${t.role}: ${verdict.rule}`)
      return { ok: false, reason: HELD }
    }
    return { ok: true }
  }

  /** What home accepted into gate mailboxes since the cursor: sign and queue it, or apply a control. */
  const takeOutbound = () => {
    if (!mesh) return
    const self = mesh.log.origin
    const rows = mesh.log.db
      .prepare(
        `SELECT seq, address, payload FROM records WHERE origin = ? AND kind = 'comms' AND seq > ?
           AND (substr(address, 1, ${GATE_PREFIX.length}) = ? OR substr(address, 1, ${GATE_CONTROL.length}) = ?) ORDER BY seq`,
      )
      .all(self, store.cursor('outbound'), GATE_PREFIX, GATE_CONTROL) as { seq: number; address: string; payload: string }[]
    for (const r of rows) {
      store.setCursor('outbound', r.seq)
      const localId = `${self}.${r.seq}`
      const origin = (mesh.log.db.prepare('SELECT origin FROM routed_in WHERE local_id = ?').get(localId) as { origin: string } | undefined)?.origin
      const env = decode(localId, r.payload)
      if (!origin || !env) {
        finishLocal(localId)
        continue
      }
      if (r.address.startsWith(GATE_CONTROL)) {
        const t = target(r.address, GATE_CONTROL)!
        const closed = store.closePath(roleOf(env.from), t.domain, t.role, `closed by ${env.from}`)
        audit.write({ dir: 'out', peer: t.domain, principal: env.from, decision: 'closed', rule: closed ? 'close-return' : 'close-return: no open path' })
        tellHome(origin, env.from, closed ? `return path from ${t.domain}:${t.role} to ${roleOf(env.from)} closed` : `no open return path from ${t.domain}:${t.role} to ${roleOf(env.from)}`)
        finishLocal(localId)
        continue
      }
      const t = target(r.address, GATE_PREFIX)!
      let files: XFile[] | undefined
      try {
        files = env.files?.map((f) => {
          const data = fs.readFileSync(f.path!)
          return { name: f.name, size: data.length, sha256: sha256(data), data: data.toString('base64') }
        })
      } catch (err) {
        finishLocal(localId, `its files could not be read at the gateway (${err instanceof Error ? err.message : String(err)})`)
        continue
      }
      const x: XMsg = {
        t: 'xmsg',
        id: localId,
        kind: env.ref ? 'answer' : 'message',
        from: { domain: config().domain, human: env.human ?? 'unknown', role: roleOf(env.from), member: memberOf(env.from) },
        to: { domain: t.domain, role: t.role },
        body: env.body ?? '',
        ...(files?.length ? { files } : {}),
        at: env.stamp,
      }
      const frame = { ...x, sig: sign(x, key.privateKey) }
      store.db
        .prepare("INSERT OR IGNORE INTO outbound (xid, local_id, origin_node, sender, peer, to_role, frame, status, created) VALUES (?,?,?,?,?,?,?,'queued',?)")
        .run(localId, localId, origin, env.from, t.domain, t.role, JSON.stringify(frame), Date.now())
      const opened = store.openPath(roleOf(env.from), t.domain, t.role, env.from)
      audit.write({ dir: 'out', peer: t.domain, principal: env.from, kind: x.kind, decision: 'admitted', rule: `announced or heard; return path ${opened}`, payloadHash: payloadHash(x.body) })
    }
  }

  const sendDue = (now = Date.now()) => {
    const due = store.db.prepare("SELECT xid, peer, frame, last_sent FROM outbound WHERE status IN ('queued', 'sent')").all() as {
      xid: string
      peer: string
      frame: string
      last_sent: number
    }[]
    for (const o of due) {
      if (now - o.last_sent < RESEND_MS || !links.linked(o.peer)) continue
      if (links.send(o.peer, JSON.parse(o.frame) as Frame)) {
        store.db.prepare("UPDATE outbound SET status = 'sent', last_sent = ? WHERE xid = ?").run(now, o.xid)
      }
    }
  }

  // ── from peers ────────────────────────────────────────────────────────────

  const onAck = (domain: string, f: Frame) => {
    const o = store.db.prepare('SELECT * FROM outbound WHERE xid = ? AND peer = ?').get(String(f.id), domain) as
      | { xid: string; local_id: string; origin_node: string; sender: string; to_role: string; status: string; frame: string }
      | undefined
    if (!o || o.status === 'read' || o.status === 'refused') return
    if (f.status === 'delivered') {
      store.db.prepare("UPDATE outbound SET status = 'delivered' WHERE xid = ?").run(o.xid)
    } else if (f.status === 'read') {
      store.db.prepare("UPDATE outbound SET status = 'read' WHERE xid = ?").run(o.xid)
      audit.write({ dir: 'out', peer: domain, principal: o.sender, decision: 'read', rule: 'peer read' })
      if (mesh) finishLocal(o.local_id)
    } else if (f.status === 'refused') {
      const reason = typeof f.reason === 'string' ? f.reason.slice(0, 200) : 'refused'
      store.db.prepare("UPDATE outbound SET status = 'refused', reason = ? WHERE xid = ?").run(reason, o.xid)
      audit.write({ dir: 'out', peer: domain, principal: o.sender, decision: 'refused', rule: `by ${domain}: ${reason}` })
      // FAILED at home, never READ: READ would claim a delivery that did not happen (PM, 21 Oct).
      if (mesh) finishLocal(o.local_id, `refused by ${domain}: ${reason}`)
    }
  }

  const refuseIn = (domain: string, id: string, rule: string, reason: string, x?: Partial<XMsg>) => {
    audit.write({ dir: 'in', peer: domain, principal: x?.from ? `${x.from.role}/${x.from.human}` : undefined, kind: x?.kind, decision: 'refused', rule, payloadHash: x?.body ? payloadHash(x.body) : undefined })
    if (id) store.db.prepare("INSERT OR IGNORE INTO inbound (peer, xid, to_role, status, at) VALUES (?,?,?,'refused',?)").run(domain, id, x?.to?.role ?? '', Date.now())
    links.send(domain, { t: 'xack', id, status: 'refused', reason })
  }

  const onXMsg = (domain: string, f: Frame) => {
    if (!isXMsg(f)) return refuseIn(domain, typeof f.id === 'string' ? f.id : '', 'malformed', 'malformed record')
    const prior = store.db.prepare('SELECT status FROM inbound WHERE peer = ? AND xid = ?').get(domain, f.id) as { status: string } | undefined
    if (prior) {
      // A resend: answer from what was recorded.
      if (prior.status === 'refused') links.send(domain, { t: 'xack', id: f.id, status: 'refused', reason: 'refused before' })
      else if (prior.status !== 'admitted') links.send(domain, { t: 'xack', id: f.id, status: prior.status })
      return
    }
    const peerKey = links.peerKey(domain)
    if (!peerKey || !verify(f, peerKey)) return refuseIn(domain, f.id, 'signature', 'the signature does not verify', f)
    if (f.from.domain !== domain) return refuseIn(domain, f.id, 'domain', `it says it is from ${f.from.domain}; its key says ${domain}`, f)
    if (f.to.domain !== config().domain) return refuseIn(domain, f.id, 'domain', `not for ${config().domain}`, f)
    if (!(COMM_KINDS as readonly string[]).includes(f.kind)) return refuseIn(domain, f.id, 'kind filter', `${config().domain} accepts communication only (message, question, answer); actions are never accepted here`, f)
    if (!NAME.test(f.from.role) || !NAME.test(f.to.role)) return refuseIn(domain, f.id, 'names', 'role names must be lowercase slugs', f)
    if (f.body.length > MAX_BODY) return refuseIn(domain, f.id, 'size', `the body is over ${MAX_BODY} characters`, f)
    const exposed = exposedTo(config(), domain, f.from.human, f.from.role).includes(f.to.role)
    const onPath = !exposed && store.isOpen(f.to.role, domain, f.from.role)
    if (!exposed && !onPath) return refuseIn(domain, f.id, 'exposure', `${f.to.role} is not exposed to ${domain}/${f.from.human}/${f.from.role}`, f)
    // The inbound scan keeps secrets out of home's logs; a hit is refused, never passed on.
    if (scanForSecrets(f.body).length) return refuseIn(domain, f.id, 'secret scan', 'it carries what looks like a secret', f)
    const node = nodeOfRole(f.to.role)
    if (!mesh || !node) return refuseIn(domain, f.id, 'unavailable', `${f.to.role} is unavailable`, f)
    let staged: { dir: string; entries: FileEntry[] } | undefined
    if (f.files?.length) {
      const datas = f.files.map((x) => Buffer.from(x.data, 'base64'))
      if (datas.reduce((n, d) => n + d.length, 0) > GATE_FILES_MAX) return refuseIn(domain, f.id, 'size', `files over ${GATE_FILES_MAX / 1048576} MB`, f)
      const bad = f.files.find((x, i) => datas[i]!.length !== x.size || sha256(datas[i]!) !== x.sha256)
      if (bad) return refuseIn(domain, f.id, 'files', `${bad.name} does not match its size and hash`, f)
      const secret = f.files.find((_, i) => !isBinary(datas[i]!) && scanForSecrets(datas[i]!.toString('utf-8')).length)
      if (secret) return refuseIn(domain, f.id, 'secret scan', `${secret.name} carries what looks like a secret`, f)
      // Staged as a routed snapshot: the mesh carries it home in chunks, and removes it once home has READ it.
      const dir = path.join(mesh.log.dir, 'files', 'out', crypto.randomUUID())
      fs.mkdirSync(dir, { recursive: true })
      f.files.forEach((x, i) => {
        fs.mkdirSync(path.dirname(path.join(dir, x.name)), { recursive: true })
        fs.writeFileSync(path.join(dir, x.name), datas[i]!)
      })
      staged = { dir, entries: f.files.map((x) => ({ name: x.name, size: x.size, sha256: x.sha256, chunks: chunksOf(x.size) })) }
    }
    const env: Envelope = {
      v: 1,
      type: 'msg',
      stamp: Date.now(),
      from: `${domain}:${f.from.role}/${f.from.human}`,
      to: f.to.role,
      // Data, never work: not claimable, and framed as foreign wherever it is shown.
      notify: true,
      foreign: { domain, human: f.from.human, role: f.from.role, ...(f.from.member ? { member: f.from.member } : {}), xid: f.id, kind: f.kind },
      ...(staged ? { files: staged.entries.map((e) => ({ name: e.name, size: e.size, sha256: e.sha256 })) } : {}),
      body: f.body,
    }
    const rec = routeHome(node, ADDR.role(f.to.role), env, staged)
    store.db.prepare("INSERT INTO inbound (peer, xid, route_id, to_role, status, at) VALUES (?,?,?,?,'admitted',?)").run(domain, f.id, `${rec.origin}.${rec.seq}`, f.to.role, Date.now())
    store.heard(domain, f.from.role)
    if (onPath) store.usePath(f.to.role, domain, f.from.role)
    audit.write({ dir: 'in', peer: domain, principal: `${f.from.role}/${f.from.human}`, kind: f.kind, decision: 'admitted', rule: exposed ? 'exposed' : 'return path', payloadHash: payloadHash(f.body) })
  }

  /** Tell each peer how its records fared at home: DELIVERED, then READ, or refused. */
  const ackInbound = () => {
    if (!mesh) return
    const open = store.db.prepare("SELECT peer, xid, route_id, status FROM inbound WHERE status IN ('admitted', 'delivered') AND route_id IS NOT NULL").all() as {
      peer: string
      xid: string
      route_id: string
      status: string
    }[]
    for (const i of open) {
      if (!links.linked(i.peer)) continue
      const o = mesh.log.db.prepare('SELECT delivered_at, read_at, failed FROM outbox WHERE id = ?').get(i.route_id) as
        | { delivered_at: number | null; read_at: number | null; failed: string | null }
        | undefined
      if (!o) continue
      const next = o.failed ? 'refused' : o.read_at ? 'read' : o.delivered_at ? 'delivered' : undefined
      if (!next || next === i.status) continue
      if (!links.send(i.peer, { t: 'xack', id: i.xid, status: next, ...(o.failed ? { reason: 'not delivered at home' } : {}) })) continue
      store.db.prepare('UPDATE inbound SET status = ? WHERE peer = ? AND xid = ?').run(next, i.peer, i.xid)
      if (next !== 'delivered') audit.write({ dir: 'in', peer: i.peer, decision: next === 'read' ? 'read' : 'refused', rule: next === 'read' ? 'home read' : `home: ${o.failed}` })
    }
  }

  // ── exposure and availability ─────────────────────────────────────────────

  /**
   * The roles exposed to a peer, and which of them have no reachable node now. Roles only, never node names.
   * Sent when it changes (an exposure edit, a home node going away or coming back), and on every link.
   */
  const exposed = new Map<string, string>()
  const exposeTo = (domain: string, onlyIfChanged = false) => {
    const roles = exposedToDomain(config(), domain)
    const frame = { t: 'exposure', roles, unavailable: mesh ? roles.filter((r) => !nodeOfRole(r, true)) : [] }
    const key = JSON.stringify(frame)
    if (onlyIfChanged && exposed.get(domain) === key) return
    if (links.send(domain, frame)) exposed.set(domain, key)
  }

  const onExposure = (domain: string, f: Frame) => {
    const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((r): r is string => typeof r === 'string' && NAME.test(r)))].sort() : [])
    store.setPeerRoles(domain, list(f.roles), list(f.unavailable))
    publishExternal()
  }

  /** Each external domain this gateway serves, for home: replicated, latest only. */
  const published = new Map<string, string>()
  const publishExternal = () => {
    if (!mesh) return
    const roles = new Map(store.peerRoles().map((p) => [p.peer, p]))
    for (const p of config().peers) {
      const r = roles.get(p.domain)
      const paths = store
        .paths()
        .filter((x) => x.ext_domain === p.domain)
        .map((x) => ({ role: x.internal_role, from: x.ext_role }))
        .sort((a, b) => `${a.role}:${a.from}`.localeCompare(`${b.role}:${b.from}`))
      const notice: ExternalNotice = { domain: p.domain, linked: links.linked(p.domain), roles: r?.roles ?? [], unavailable: r?.unavailable ?? [], paths }
      const body = JSON.stringify(notice)
      if (published.get(p.domain) === body) continue
      mesh.log.append('external', EXTERNAL_ADDRESS, body, p.domain)
      published.set(p.domain, body)
    }
  }

  // ── links ─────────────────────────────────────────────────────────────────

  const links = new ExternalLinks(config, key, {
    onLink: (domain) => {
      say(`linked to ${domain}`)
      audit.write({ dir: 'link', peer: domain, decision: 'opened', rule: 'pinned key' })
      links.send(domain, { t: 'hello', v: 1, domain: config().domain })
      exposeTo(domain)
      store.db.prepare("UPDATE outbound SET last_sent = 0 WHERE peer = ? AND status IN ('queued', 'sent')").run(domain)
      publishExternal()
    },
    onFrame: (domain: string, frame: Frame) => {
      switch (frame.t) {
        case 'hello':
          if (frame.domain !== domain) say(`${domain} says it is ${String(frame.domain)}; its key says ${domain}, and the key wins`)
          return
        case 'exposure':
          return onExposure(domain, frame)
        case 'xmsg':
          return onXMsg(domain, frame)
        case 'xack':
          return onAck(domain, frame)
      }
    },
    onDrop: (domain) => {
      say(`link to ${domain} dropped`)
      publishExternal()
    },
    onRefused: (source, why) => {
      say(`refused ${source}: ${why}`)
      if (/^banned/.test(why)) audit.write({ dir: 'link', peer: source, decision: 'banned', rule: why })
    },
  })
  await links.listen()

  /**
   * Return paths that can no longer carry anything, or that the operator closes on this box. The CLI never
   * writes the audit itself (this process holds the chain's head): it drops a request in control/, taken here.
   */
  const closePaths = () => {
    const peers = new Set(config().peers.map((p) => p.domain))
    for (const p of store.paths()) {
      if (peers.has(p.ext_domain)) continue
      store.closePath(p.internal_role, p.ext_domain, p.ext_role, 'peer removed from gateway.json')
      audit.write({ dir: 'out', peer: p.ext_domain, principal: p.internal_role, decision: 'closed', rule: 'peer removed from gateway.json' })
    }
    const control = path.join(deps.dir, 'control')
    for (const name of fs.existsSync(control) ? fs.readdirSync(control).filter((n) => n.endsWith('.json')) : []) {
      const file = path.join(control, name)
      try {
        const r = JSON.parse(fs.readFileSync(file, 'utf-8')) as { op?: string; role?: string; domain?: string; from?: string; by?: string }
        if (r.op === 'close-path' && r.role && r.domain && r.from) {
          const closed = store.closePath(r.role, r.domain, r.from, `closed on the gateway by ${r.by ?? 'the operator'}`)
          audit.write({ dir: 'out', peer: r.domain, principal: r.role, decision: 'closed', rule: closed ? `operator: ${r.by ?? 'unknown'}` : 'operator: no open path' })
        }
      } catch (err) {
        say(`control request ${name} ignored: ${err instanceof Error ? err.message : String(err)}`)
      }
      fs.rmSync(file, { force: true })
    }
  }

  const pump = () => {
    try {
      closePaths()
      for (const p of config().peers) if (links.linked(p.domain)) exposeTo(p.domain, true)
      takeOutbound()
      sendDue()
      ackInbound()
    } catch (err) {
      say(`pump: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const status = () => {
    publishExternal()
    const peers = config().peers.map((p) => ({ domain: p.domain, ...(p.address ? { address: p.address } : {}), linked: links.linked(p.domain) }))
    const paths = store.paths().length
    const mailbox = (store.db.prepare("SELECT COUNT(*) n FROM inbound WHERE status IN ('admitted', 'delivered')").get() as { n: number }).n
    const banned = links.banned()
    const auditState = chain.ok ? { ok: true, lines: audit.head.seq } : { ok: false, lines: audit.head.seq, broken: `line ${chain.line}: ${chain.why}` }
    writeGatewayStatus(deps.dir, { domain: config().domain, pin: key.pin, port: links.port, updatedAt: Date.now(), peers, paths, mailbox, banned, audit: auditState })
    writeMetrics(deps.dir, renderMetrics(crossings, { peers, paths, mailbox, banned: banned.length, auditLines: audit.head.seq, auditOk: chain.ok }))
  }
  const verifyChain = () => {
    const was = chain.ok
    const now = verifyAudit(deps.dir)
    chain = now
    if (!now.ok && was) say(`the audit chain is broken at line ${now.line}: ${now.why}`)
  }
  const expose = () => {
    for (const p of config().peers) if (links.linked(p.domain)) exposeTo(p.domain)
    for (const p of store.closeIdle(config().pathIdleDays * 86_400_000)) {
      audit.write({ dir: 'out', peer: p.ext_domain, principal: p.internal_role, decision: 'closed', rule: `unused for ${config().pathIdleDays} days` })
    }
  }
  status()
  const timers = [setInterval(pump, 500), setInterval(status, 2_000), setInterval(expose, EXPOSE_MS), setInterval(verifyChain, VERIFY_MS)]
  return {
    config,
    links,
    store,
    accept,
    scanFile,
    pump,
    close: async () => {
      for (const t of timers) clearInterval(t)
      await links.close()
      store.close()
    },
  }
}
