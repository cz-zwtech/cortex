/**
 * What crosses two gateways, in one process: real links and real mesh logs,
 * with the routers played by the test (a message accepted into a gate mailbox
 * is appended as the router would, and a route-out is read back from the log).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { decode, encode } from '../../comms/server/envelope.js'
import type { Envelope } from '../../comms/server/types.js'
import { MeshLog } from '../../comms/server/mesh/log.js'
import { NodeTable } from '../../comms/server/mesh/nodes.js'
import { ACKS_ADDRESS, OUTBOX_ADDRESS, openOutbox, type RouteOut } from '../../comms/server/mesh/router.js'
import { EXTERNAL_ADDRESS } from '../../comms/server/mesh/view.js'
import { verifyAudit } from '../server/audit.js'
import { startGateway, type Gateway } from '../server/gateway.js'
import { ensureDomainKey, loadDomainKey, sign } from '../server/keys.js'

const dirs: string[] = []
const running: Gateway[] = []
after(async () => {
  for (const g of running) await g.close()
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }))
})

const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => ok(p))
    })
  })
const until = async (what: string, fn: () => boolean, ms = 8_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(`timed out waiting for: ${what}`)
}

/** A gateway node: its data dir and key, a mesh log, and one home node holding `homeRole`. */
const site = (domain: string, node: string, home: string, homeRole: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gwflow-${domain}-`))
  dirs.push(dir)
  const pin = ensureDomainKey(path.join(dir, 'gw'), domain).pin
  const log = new MeshLog(path.join(dir, 'mesh'), node)
  openOutbox(log.db)
  new NodeTable(log.db).announced({ v: 1, node: home, addresses: [], intent: 'node', links: [], roles: [{ role: homeRole, members: [{ name: `${homeRole}-1` }] }] })
  return { dir: path.join(dir, 'gw'), pin, log, home, up: new Set([home]) }
}
type Site = ReturnType<typeof site>
const configure = (s: Site, c: Record<string, unknown>) => fs.writeFileSync(path.join(s.dir, 'gateway.json'), JSON.stringify(c))
const start = async (s: Site) => {
  const g = await startGateway({ dir: s.dir, log: () => {}, mesh: { log: s.log, reachable: () => s.up } })
  running.push(g)
  return g
}

let n = 0
/** Home sends to a gate mailbox: the gateway's accept, then what the router does with an accepted message. */
const homeSends = (g: Gateway, s: Site, address: string, from: string, body: string, extra: Partial<Envelope> = {}) => {
  const env: Envelope = { v: 1, type: 'msg', stamp: Date.now(), from, to: address, human: 'alex', body, ...extra }
  const v = g.accept(address, encode(env), s.home)
  if (v.ok) {
    const rec = s.log.append('comms', address, encode(env))
    s.log.db.prepare('INSERT INTO routed_in (origin, id, local_id, at) VALUES (?,?,?,?)').run(s.home, `${s.home}.${++n}`, `${rec.origin}.${rec.seq}`, Date.now())
  }
  return v
}
/** Route-outs this gateway wrote toward home. */
const toHome = (s: Site) =>
  s.log.read(OUTBOX_ADDRESS).filter((r) => r.kind === 'route-out').map((r) => {
    const out = JSON.parse(r.payload) as RouteOut
    return { ...out, id: `${r.origin}.${r.seq}`, env: decode('x', out.body)! }
  })
/** Home's router says the route-out was read there. */
const homeRead = (s: Site, id: string) => s.log.db.prepare('INSERT OR REPLACE INTO outbox (id, to_node, address, created, delivered_at, read_at) VALUES (?,?,?,?,?,?)').run(id, s.home, 'x', Date.now(), Date.now(), Date.now())
const audit = (s: Site) => fs.readFileSync(path.join(s.dir, 'audit.jsonl'), 'utf-8')

const pair = async () => {
  const E = site('home', 'node-e', 'node-b', 'dev')
  const F = site('partner', 'node-f', 'node-g', 'acme-dev')
  const ep = await freePort()
  configure(E, { domain: 'home', listen: { host: '127.0.0.1', port: ep }, peers: [{ domain: 'partner', pin: F.pin }] })
  configure(F, { domain: 'partner', listen: { host: '127.0.0.1', port: await freePort() }, peers: [{ domain: 'home', address: `127.0.0.1:${ep}`, pin: E.pin }] })
  const e = await start(E)
  const f = await start(F)
  await until('linked', () => e.links.linked('partner') && f.links.linked('home'))
  return { E, F, e, f }
}

test('nothing is exposed by default: the peer is told no roles, a send to one is refused at its own gateway, and a forged one is refused by exposure', async () => {
  const { E, F, e, f } = await pair()
  await until('F heard the exposure', () => f.store.peerRoles().some((p) => p.peer === 'home'))
  assert.deepEqual(f.store.peerRoles()[0]!.roles, [], 'every role unticked by default')
  assert.deepEqual(homeSends(f, F, 'gate:home:dev', 'acme-dev/acme-dev-1', 'hi'), { ok: false, reason: 'home has not announced dev' })

  // A peer that ignores its own check: signed by partner's real key, so only exposure stops it.
  const x = { t: 'xmsg', id: 'forged.1', kind: 'message', from: { domain: 'partner', human: 'alex', role: 'acme-dev' }, to: { domain: 'home', role: 'dev' }, body: 'hi', at: Date.now() }
  f.links.send('home', { ...x, sig: sign(x, loadDomainKey(F.dir).privateKey) })
  await until('refused by exposure', () => /"rule":"exposure"/.test(audit(E)))
  assert.equal(toHome(E).length, 0, 'nothing reached home')
  assert.equal(e.store.db.prepare("SELECT status FROM inbound WHERE xid = 'forged.1'").pluck().get(), 'refused')
})

test('ticked: partner/alex/acme-dev reaches dev at home as foreign data, never claimable; READ at home goes back to the sender as READ', async () => {
  const { E, F, e, f } = await pair()
  configure(E, { domain: 'home', listen: { host: '127.0.0.1', port: e.links.port }, peers: [{ domain: 'partner', pin: F.pin, expose: [{ human: 'alex', role: 'acme-dev', roles: ['dev'] }] }] })
  await until('F sees dev announced', () => f.store.peerRoles().some((p) => p.roles.includes('dev')))
  await until('home sees home in the external record', () =>
    F.log.read(EXTERNAL_ADDRESS).some((r) => (JSON.parse(r.payload) as { roles: string[] }).roles.includes('dev')),
  )
  assert.deepEqual(homeSends(f, F, 'gate:home:dev', 'acme-dev/acme-dev-1', 'can you review the schema?'), { ok: true })
  await until('E handed it to home', () => toHome(E).length === 1)
  const [out] = toHome(E)
  const xid = f.store.db.prepare('SELECT xid FROM outbound').pluck().get() as string
  assert.equal(out!.to, 'node-b')
  assert.equal(out!.address, 'cortex-comms:role:dev')
  assert.equal(out!.env.notify, true, 'data: never a work message')
  assert.deepEqual(out!.env.foreign, { domain: 'partner', human: 'alex', role: 'acme-dev', member: 'acme-dev-1', xid, kind: 'message' })
  assert.equal(out!.env.from, 'partner:acme-dev/alex')
  assert.match(audit(E), /"decision":"admitted","rule":"exposed"/)

  homeRead(E, out!.id)
  await until('F hears READ, and tells its home READ', () => F.log.read(ACKS_ADDRESS).some((r) => r.payload.includes(xid)))
  assert.equal(f.store.db.prepare('SELECT status FROM outbound WHERE xid = ?').pluck().get(xid), 'read')
  assert.equal(F.log.db.prepare("SELECT COUNT(*) FROM records WHERE kind = 'comms' AND address LIKE 'gate:%'").pluck().get(), 0, 'the body left the gateway')
})

test('an action kind is refused; a record from another domain than its key is refused', async () => {
  const { E, F, e, f } = await pair()
  configure(E, { domain: 'home', listen: { host: '127.0.0.1', port: e.links.port }, peers: [{ domain: 'partner', pin: F.pin, expose: [{ human: 'alex', role: 'acme-dev', roles: ['dev'] }] }] })
  const k = loadDomainKey(F.dir).privateKey
  const base = { t: 'xmsg', from: { domain: 'partner', human: 'alex', role: 'acme-dev' }, to: { domain: 'home', role: 'dev' }, body: 'run deploy', at: Date.now() }
  const a = { ...base, id: 'a.1', kind: 'action' }
  f.links.send('home', { ...a, sig: sign(a, k) })
  const b = { ...base, id: 'a.2', kind: 'message', from: { ...base.from, domain: 'ht' } }
  f.links.send('home', { ...b, sig: sign(b, k) })
  const c = { ...base, id: 'a.3', kind: 'message' }
  f.links.send('home', { ...c, sig: sign({ ...c, body: 'changed' }, k) })
  await until('three refusals', () => (audit(E).match(/"decision":"refused"/g) ?? []).length >= 3)
  assert.match(audit(E), /"rule":"kind filter"/)
  assert.match(audit(E), /"rule":"domain"/)
  assert.match(audit(E), /"rule":"signature"/)
  assert.equal(toHome(E).length, 0)
  assert.deepEqual(verifyAudit(E.dir).ok, true)
})

test('a return path: home writes to an announced role, the reply comes back on the path; close-return refuses the next; a held message never leaves', async () => {
  const { E, F, e, f } = await pair()
  // partner exposes acme-dev to home's pm; home exposes nothing.
  configure(F, { domain: 'partner', listen: { host: '127.0.0.1', port: f.links.port }, peers: [{ domain: 'home', address: `127.0.0.1:${e.links.port}`, pin: E.pin, expose: [{ human: 'alex', role: 'pm', roles: ['acme-dev'] }] }] })
  new NodeTable(E.log.db).announced({ v: 1, node: 'node-b', addresses: [], intent: 'node', links: [], roles: [{ role: 'pm', members: [{ name: 'pm' }] }] })
  await until('E sees acme-dev announced', () => e.store.peerRoles().some((p) => p.roles.includes('acme-dev')))

  assert.deepEqual(homeSends(e, E, 'gate:partner:acme-dev', 'pm/pm', 'the key is AKIAABCDEFGHIJKLMNOP'), { ok: false, reason: 'held for review' })
  assert.match(audit(E), /"decision":"held","rule":"secret gate/)

  assert.deepEqual(homeSends(e, E, 'gate:partner:acme-dev', 'pm/pm', 'what is the status?'), { ok: true })
  await until('F handed it to its home', () => toHome(F).length === 1)
  assert.equal(e.store.isOpen('pm', 'partner', 'acme-dev'), true, 'the path opened')
  await until("home sees the path in partner's external record", () =>
    E.log.read(EXTERNAL_ADDRESS).some((r) => JSON.stringify((JSON.parse(r.payload) as { paths?: unknown }).paths) === '[{"role":"pm","from":"acme-dev"}]'),
  )

  // acme-dev answers pm: pm is not announced by home, but it wrote to acme-dev, and the path admits it.
  assert.deepEqual(homeSends(f, F, 'gate:home:pm', 'acme-dev/acme-dev-1', 'green', { ref: 'x' }), { ok: true })
  await until('the answer reached pm', () => toHome(E).some((o) => o.env.foreign?.kind === 'answer'))
  assert.match(audit(E), /"rule":"return path"/)

  assert.deepEqual(homeSends(e, E, 'gate-ctl:close:partner:acme-dev', 'pm/pm', 'close-return'), { ok: true })
  await until('closed', () => !e.store.isOpen('pm', 'partner', 'acme-dev'))
  assert.ok(toHome(E).some((o) => o.env.body?.includes('return path from partner:acme-dev to pm closed')), 'pm is told')
  homeSends(f, F, 'gate:home:pm', 'acme-dev/acme-dev-1', 'one more', { ref: 'x' })
  await until('refused: F asks its router to fail it at home, never READ', () =>
    F.log.read(ACKS_ADDRESS).some((r) => r.kind === 'route-refuse' && /refused by home: pm is not exposed/.test(r.payload)),
  )
  assert.equal(F.log.read(ACKS_ADDRESS).filter((r) => r.kind === 'route-ack').length, 0, 'nothing claimed READ')
})

test('availability: a home node going away makes its role unavailable to the peer at once; a message for it waits at the gateway and is delivered, then READ, when it is back', async () => {
  const { E, F, e, f } = await pair()
  configure(E, { domain: 'home', listen: { host: '127.0.0.1', port: e.links.port }, peers: [{ domain: 'partner', pin: F.pin, expose: [{ human: 'alex', role: 'acme-dev', roles: ['dev'] }] }] })
  await until('dev announced', () => f.store.peerRoles().some((p) => p.roles.includes('dev')))
  E.up.clear()
  await until('F hears dev unavailable', () => f.store.peerRoles().some((p) => p.unavailable.includes('dev')), 3_000)
  await until("F's home sees it in the external record", () =>
    F.log.read(EXTERNAL_ADDRESS).some((r) => (JSON.parse(r.payload) as { unavailable: string[] }).unavailable.includes('dev')),
  )

  assert.deepEqual(homeSends(f, F, 'gate:home:dev', 'acme-dev/acme-dev-1', 'while you were out'), { ok: true })
  await until('E holds it as the origin, addressed to the node that holds dev', () => toHome(E).length === 1)
  const xid = f.store.db.prepare('SELECT xid FROM outbound').pluck().get() as string
  assert.equal(f.store.db.prepare('SELECT status FROM outbound').pluck().get(), 'sent', 'not yet delivered')

  E.up.add('node-b')
  await until('available again', () => f.store.peerRoles().some((p) => p.unavailable.length === 0), 3_000)
  const id = toHome(E)[0]!.id
  E.log.db.prepare('INSERT INTO outbox (id, to_node, address, created, delivered_at) VALUES (?,?,?,?,?)').run(id, 'node-b', 'x', Date.now(), Date.now())
  await until('DELIVERED reaches F', () => f.store.db.prepare('SELECT status FROM outbound WHERE xid = ?').pluck().get(xid) === 'delivered')
  homeRead(E, id)
  await until('then READ', () => f.store.db.prepare('SELECT status FROM outbound WHERE xid = ?').pluck().get(xid) === 'read')
})

test('a restart keeps return paths, the mailbox and what was already admitted: a resend after the restart is not handed home twice', async () => {
  const { E, F, e, f } = await pair()
  configure(E, { domain: 'home', listen: { host: '127.0.0.1', port: e.links.port }, peers: [{ domain: 'partner', pin: F.pin, expose: [{ human: 'alex', role: 'acme-dev', roles: ['dev'] }] }] })
  configure(F, { domain: 'partner', listen: { host: '127.0.0.1', port: f.links.port }, peers: [{ domain: 'home', address: `127.0.0.1:${e.links.port}`, pin: E.pin, expose: [{ human: 'alex', role: 'pm', roles: ['acme-dev'] }] }] })
  new NodeTable(E.log.db).announced({ v: 1, node: 'node-b', addresses: [], intent: 'node', links: [], roles: [{ role: 'dev', members: [{ name: 'dev-1' }] }, { role: 'pm', members: [{ name: 'pm' }] }] })
  await until('E sees acme-dev', () => e.store.peerRoles().some((p) => p.roles.includes('acme-dev')))
  homeSends(e, E, 'gate:partner:acme-dev', 'pm/pm', 'opening a path')
  await until('path open', () => e.store.isOpen('pm', 'partner', 'acme-dev'))
  await until('dev announced to F', () => f.store.peerRoles().some((p) => p.roles.includes('dev')))
  homeSends(f, F, 'gate:home:dev', 'acme-dev/acme-dev-1', 'held in the mailbox')
  await until('in E\'s mailbox', () => toHome(E).some((o) => o.env.body === 'held in the mailbox'))
  const frame = JSON.parse(f.store.db.prepare('SELECT frame FROM outbound WHERE to_role = ?').pluck().get('dev') as string)

  await e.close()
  running.splice(running.indexOf(e), 1)
  const e2 = await start(E)
  await until('relinked', () => e2.links.linked('partner') && f.links.linked('home'), 15_000)
  assert.equal(e2.store.isOpen('pm', 'partner', 'acme-dev'), true, 'the return path survived')
  assert.equal(JSON.parse(fs.readFileSync(path.join(E.dir, 'status.json'), 'utf-8')).mailbox, 1, 'the mailbox survived')
  f.links.send('home', frame)
  await new Promise((r) => setTimeout(r, 1_000))
  assert.equal(toHome(E).filter((o) => o.env.body === 'held in the mailbox').length, 1, 'a resend is not handed home twice')
})

test('files cross inline and signed, and land at home as a routed snapshot; a mismatched or secret-bearing file is refused; outbound, the sanitizer holds a file', async () => {
  const { E, F, e, f } = await pair()
  configure(E, { domain: 'home', listen: { host: '127.0.0.1', port: e.links.port }, peers: [{ domain: 'partner', pin: F.pin, expose: [{ human: 'alex', role: 'acme-dev', roles: ['dev'] }] }] })
  await until('dev announced', () => f.store.peerRoles().some((p) => p.roles.includes('dev')))
  // What F's router leaves after receiving files from home: the message, with where each file landed on F.
  const src = path.join(F.dir, 'schema.sql')
  fs.writeFileSync(src, 'CREATE TABLE t (id int);\n')
  const { sha256 } = await import('../../comms/server/mesh/files.js')
  const data = fs.readFileSync(src)
  assert.deepEqual(homeSends(f, F, 'gate:home:dev', 'acme-dev/acme-dev-1', 'the schema', { files: [{ name: 'schema.sql', path: src, size: data.length, sha256: sha256(data) }] }), { ok: true })
  await until('E staged it for home', () => toHome(E).length === 1)
  const [out] = toHome(E)
  assert.equal(out!.env.files?.[0]?.name, 'schema.sql')
  assert.equal(fs.readFileSync(path.join(out!.files!.dir, 'schema.sql'), 'utf-8'), 'CREATE TABLE t (id int);\n')
  assert.deepEqual(out!.files!.entries, [{ name: 'schema.sql', size: data.length, sha256: sha256(data), chunks: 1 }])

  const k = loadDomainKey(F.dir).privateKey
  const base = { t: 'xmsg', kind: 'message', from: { domain: 'partner', human: 'alex', role: 'acme-dev' }, to: { domain: 'home', role: 'dev' }, body: 'files', at: Date.now() }
  const file = (text: string, o: Record<string, unknown> = {}) => ({ name: 'a.txt', size: Buffer.byteLength(text), sha256: sha256(text), data: Buffer.from(text).toString('base64'), ...o })
  const a = { ...base, id: 'fx.1', files: [file('hello', { size: 99 })] }
  f.links.send('home', { ...a, sig: sign(a, k) })
  const b = { ...base, id: 'fx.2', files: [file('aws AKIAABCDEFGHIJKLMNOP')] }
  f.links.send('home', { ...b, sig: sign(b, k) })
  await until('both refused', () => (audit(E).match(/"rule":"(files|secret scan)"/g) ?? []).length >= 2)
  assert.equal(toHome(E).length, 1, 'neither reached home')

  const secret = path.join(E.dir, 'creds.txt')
  fs.writeFileSync(secret, 'AKIAABCDEFGHIJKLMNOP\n')
  assert.equal(e.scanFile(secret, 'gate:partner:acme-dev'), 'held for review')
  assert.match(audit(E), /"decision":"held","rule":"file: secret gate/)
  assert.doesNotMatch(audit(E), /AKIA/)
  const bin = path.join(E.dir, 'blob.bin')
  fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3]))
  assert.equal(e.scanFile(bin, 'gate:partner:acme-dev'), undefined, 'binary passes, as at every node')
})

test('return paths close on this box: by the operator (a control request the running gateway takes and audits), and when their peer leaves gateway.json', async () => {
  const { E, F, e, f } = await pair()
  configure(F, { domain: 'partner', listen: { host: '127.0.0.1', port: f.links.port }, peers: [{ domain: 'home', address: `127.0.0.1:${e.links.port}`, pin: E.pin, expose: [{ human: 'alex', role: 'pm', roles: ['acme-dev'] }] }] })
  await until('E sees acme-dev', () => e.store.peerRoles().some((p) => p.roles.includes('acme-dev')))
  homeSends(e, E, 'gate:partner:acme-dev', 'pm/pm', 'one')
  homeSends(e, E, 'gate:partner:acme-dev', 'dev/dev-1', 'two')
  await until('two paths open', () => e.store.paths().length === 2)

  fs.mkdirSync(path.join(E.dir, 'control'), { recursive: true })
  fs.writeFileSync(path.join(E.dir, 'control', 'r.json'), JSON.stringify({ op: 'close-path', role: 'pm', domain: 'partner', from: 'acme-dev', by: 'claude' }))
  await until('the operator closed pm <- partner:acme-dev', () => !e.store.isOpen('pm', 'partner', 'acme-dev'))
  assert.equal(fs.existsSync(path.join(E.dir, 'control', 'r.json')), false, 'the request is consumed')
  assert.match(audit(E), /"principal":"pm","decision":"closed","rule":"operator: claude"/)
  assert.equal(e.store.isOpen('dev', 'partner', 'acme-dev'), true, 'only that one')

  configure(E, { domain: 'home', listen: { host: '127.0.0.1', port: e.links.port }, peers: [] })
  await until('the peer left: its paths close', () => e.store.paths().length === 0)
  assert.match(audit(E), /"principal":"dev","decision":"closed","rule":"peer removed from gateway.json"/)
  assert.equal(verifyAudit(E.dir).ok, true)
})
