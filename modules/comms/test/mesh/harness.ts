/**
 * Shared harness for the mesh tests: daemons on loopback in temp dirs,
 * closed and removed after each test file, plus comms sessions on them.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'
import assert from 'node:assert/strict'

import { registerKind, MeshLog } from '../../server/mesh/log.js'
import { serve } from '../../server/mesh/daemon.js'
import { meshView } from '../../server/mesh/view.js'
import { gateFile } from '../../server/mesh/files.js'
import { addPeer } from '../../server/mesh/peers.js'
import { acceptRouted, deliverFiles, localRoles, notifySender } from '../../server/meshBridge.js'
import { scanForSecrets } from '../../../../core/secrets.js'
import { Comms } from '../../server/comms.js'
import { LocalIdentity } from '../../server/identity.js'
import { MeshTransport } from '../../server/transport.js'

/** A replicated kind for tests, home only like any kind without a policy: what the retired `memory` kind used to stand in for. */
registerKind('test-flood')

export const dirs: string[] = []
export const closers: (() => Promise<void>)[] = []
after(async () => {
  for (const c of closers) await c()
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }))
})
export const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mesh-'))
  dirs.push(d)
  return d
}
export const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => ok(p))
    })
  })

export type NodeOpts = {
  roles?: string[]
  intent?: 'node' | 'relay' | 'gateway'
  peers?: string[]
  dir?: string
  port?: number
  addresses?: string[]
  caps?: string
  /** Run it as cortex-mesh serve does: roles from comms, routed delivery into comms mailboxes. */
  comms?: boolean
  alias?: string
  /** The offline limit, scaled down for tests. */
  offlineMs?: number
  rolesRecheckMs?: number
}

/** A daemon on loopback with its own dir; roles can change later through `roles`. */
export const node = async (name: string, o: NodeOpts = {}) => {
  const dir = o.dir ?? tmp()
  const port = o.port ?? (await freePort())
  const url = `http://127.0.0.1:${port}`
  for (const p of o.peers ?? []) addPeer(dir, p)
  const roles = { current: o.roles ?? (o.intent && o.intent !== 'node' ? [] : [`r-${name}`]) }
  const bridge = new MeshLog(dir, name)
  const d = await serve(dir, name, port, {
    host: '127.0.0.1',
    addresses: o.addresses ?? [url],
    intent: o.intent,
    alias: o.alias ?? name,
    ...(o.rolesRecheckMs ? { rolesRecheckMs: o.rolesRecheckMs } : {}),
    roles: o.comms
      ? localRoles(bridge)
      : () => roles.current.map((role) => ({ role, members: [{ name: `${role}-1`, ...(o.caps ? { capabilities: o.caps } : {}) }] })),
    ...(o.comms
      ? {
          accept: acceptRouted(bridge),
          notifySender: notifySender(bridge),
          files: { scan: gateFile((t) => scanForSecrets(t).map((f) => f.kind)), deliver: deliverFiles(bridge) },
        }
      : {}),
    ...(o.offlineMs ? { offline: { defaultMs: o.offlineMs, nodes: {} } } : {}),
  })
  let closed = false
  const close = async () => {
    if (!closed) await d.close()
    closed = true
  }
  closers.push(close)
  return { dir, url, port, roles, close, daemon: d, log: new MeshLog(dir, name) }
}

export const until = async (what: string, check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail(`timed out waiting for: ${what}`)
}
export const payloads = (log: MeshLog, address = 'role:x') => log.read(address).map((r) => r.payload).sort()
export const readyLinks = (n: { daemon: { links: () => { ready: boolean; live: boolean; node?: string }[] } }) =>
  n.daemon.links().filter((l) => l.live && l.ready)

export const NOWHERE = ['http://127.0.0.1:1'] // an advertised address nobody can dial

/** a and d can never link (each advertises nowhere, and neither is configured with the other). */
export const diamond = async () => {
  const b = await node('node-b')
  const c = await node('node-c')
  const a = await node('node-a', { addresses: NOWHERE, peers: [b.url, c.url] })
  const d = await node('node-d', { addresses: NOWHERE, peers: [b.url, c.url] })
  const route = (from: typeof a, to: string) => from.daemon.routes().get(to)
  await until('a routes to d', () => route(a, 'node-d')?.hops === 2, 10_000)
  return { a, b, c, d, route }
}

export const member = (logDir: string, origin: string) => {
  const t = new MeshTransport(new MeshLog(logDir, origin))
  return new Comms(t, new LocalIdentity(tmp()), { liveMs: 60_000, settleMs: 0, sleep: async () => {} })
}

export const commsOn = (n: { dir: string }, origin: string) =>
  new Comms(new MeshTransport(new MeshLog(n.dir, origin)), new LocalIdentity(tmp()), {
    liveMs: 60_000, settleMs: 0, sleep: async () => {}, mesh: () => meshView(n.dir, origin),
  })

/** node-a and the laptop, linked, each with a session in a role of its own. */
export const pair = async () => {
  const nodeA = await node('node-a-node', { comms: true, alias: 'node-a' })
  const lap = await node('lap-node', { comms: true, alias: 'laptop', peers: [nodeA.url] })
  const z = commsOn(nodeA, 'node-a-node')
  const l = commsOn(lap, 'lap-node')
  await z.join('web-dev', { create: true, as: 'web-dev-1' })
  await l.join('pm', { create: true, as: 'pm-1' })
  await until('each knows the other\'s roles and has a route', () =>
    meshView(lap.dir, 'lap-node').nodes.some((n) => n.alias === 'node-a' && n.reachable && n.roles.some((r) => r.role === 'web-dev')) &&
    meshView(nodeA.dir, 'node-a-node').nodes.some((n) => n.alias === 'laptop' && n.reachable), 10_000)
  return { nodeA, lap, z, l }
}
export const outbox = (n: { log: MeshLog }) => n.log.db.prepare('SELECT * FROM outbox').all() as { id: string; delivered_at: number | null; read_at: number | null; failed: string | null }[]

export const writeFile = (name: string, bytes: number | string, dir = tmp()) => {
  const f = path.join(dir, name)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, typeof bytes === 'string' ? bytes : crypto.randomBytes(bytes))
  return f
}
export const inboxOf = async (c: Comms, member: string) => {
  let items: Awaited<ReturnType<Comms['inbox']>> = []
  await until(`a message with files for ${member}`, () => {
    void c.inbox(member).then((x) => (items = x))
    return items.some((i) => i.files?.length)
  }, 30_000)
  return items.find((i) => i.files?.length)!
}

