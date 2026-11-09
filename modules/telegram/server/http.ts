/**
 * The two HTTP surfaces.
 *
 *  LAN (10.0.0.12:7320 and loopback, as the earlier gateway had): producers off the
 *    mesh. `GET /v1/health` with no token, COUNTS ONLY (no item ids, offsets or
 *    error text, addition D). `POST /v1/items` with the publish token.
 *    Nothing else.
 *  Socket (<dataDir>/telegram.sock, mode 0600): programs running as the service
 *    account (a timer service, another module). File permissions are the auth,
 *    which retires the session token any loopback process could present (D5).
 *    The full API, with the detail in health.
 *
 * Request bodies are JSON objects up to 64 KiB. A caller's mistake is a 4xx with
 * a reason; anything else is a 500 that names nothing internal.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'

import { Rejected, type Gateway } from './gateway.js'

type Scope = 'lan' | 'socket'
const MAX_BODY = 64 * 1024

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

const readJson = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((ok, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        fail(new Rejected('request body too large', 413))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return ok({})
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
        if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(new Rejected('the body must be a JSON object'))
        ok(v as Record<string, unknown>)
      } catch {
        fail(new Rejected('invalid JSON'))
      }
    })
    req.on('error', fail)
  })

export const handler = (gw: Gateway, scope: Scope, publishToken: string | undefined, log: (m: string) => void) =>
  async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const send = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    const url = new URL(req.url ?? '/', 'http://telegram')
    const p = url.pathname
    const m = req.method ?? 'GET'
    try {
      if (m === 'GET' && p === '/v1/health') return send(200, gw.health(scope === 'socket'))
      if (scope === 'lan') {
        const auth = req.headers.authorization ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!publishToken || !token || !sameToken(token, publishToken)) return send(401, { error: 'unauthorised' })
        if (m === 'POST' && p === '/v1/items') return send(201, gw.publish(await readJson(req)))
        return send(403, { error: 'the publish token allows POST /v1/items only' })
      }
      const q = Object.fromEntries(url.searchParams)
      let mm: RegExpExecArray | null
      if (m === 'POST' && p === '/v1/items') return send(201, gw.publish(await readJson(req)))
      if (m === 'GET' && (mm = /^\/v1\/items\/([A-Za-z0-9_]+)$/.exec(p))) return send(200, gw.show(mm[1]!))
      if (m === 'POST' && (mm = /^\/v1\/items\/([A-Za-z0-9_]+)\/ack$/.exec(p))) {
        const b = await readJson(req)
        return send(200, await gw.ack(mm[1]!, String(b.session ?? b.sender ?? ''), String(b.resolution ?? ''), typeof b.note === 'string' ? b.note : undefined))
      }
      if (m === 'POST' && (mm = /^\/v1\/items\/([A-Za-z0-9_]+)\/retry$/.exec(p))) return send(200, await gw.retryItem(mm[1]!))
      if (m === 'POST' && p === '/v1/send') {
        const b = await readJson(req)
        return send(200, await gw.send({ bot: typeof b.bot === 'string' ? b.bot : undefined, sender: String(b.sender ?? ''), text: b.text, component: b.component, topic: b.topic, idempotencyKey: b.idempotency_key, to: b.to }))
      }
      if (m === 'GET' && (mm = /^\/v1\/outbound\/([A-Za-z0-9_]+)$/.exec(p))) return send(200, gw.outbound(mm[1]!))
      if (m === 'POST' && (mm = /^\/v1\/outbound\/([A-Za-z0-9_]+)\/retry$/.exec(p))) return send(200, await gw.retryOutbound(mm[1]!))
      if (m === 'GET' && p === '/v1/replies') return send(200, { replies: gw.replies(q) })
      if (m === 'GET' && p === '/v1/info/digest') return send(200, { unreviewed_info: gw.digest() })
      if (m === 'POST' && p === '/v1/info/reviewed') {
        const b = await readJson(req)
        return send(200, gw.markReviewed(b.ids, b.by))
      }
      if (m === 'POST' && (mm = /^\/v1\/inbound\/([^/]+)\/claim$/.exec(p))) {
        const b = await readJson(req)
        return send(200, gw.claim(mm[1]!, String(b.session ?? b.sender ?? '')))
      }
      return send(404, { error: 'no such route' })
    } catch (err) {
      if (err instanceof Rejected) return send(err.status, { error: err.message })
      log(`http ${m} ${p}: ${err instanceof Error ? err.name : 'error'}`)
      return send(500, { error: 'internal error' })
    }
  }

export type Listeners = { close: () => Promise<void> }

export const listen = async (gw: Gateway, opts: { listen: string[]; socket?: string; publishToken?: string; log: (m: string) => void }): Promise<Listeners> => {
  const servers: http.Server[] = []
  const up = (s: http.Server, bind: () => void) =>
    new Promise<void>((ok, fail) => {
      s.once('error', fail)
      bind()
      s.once('listening', () => ok())
    })
  for (const addr of opts.listen) {
    const i = addr.lastIndexOf(':')
    const s = http.createServer((req, res) => void handler(gw, 'lan', opts.publishToken, opts.log)(req, res))
    await up(s, () => s.listen(Number(addr.slice(i + 1)), addr.slice(0, i)))
    servers.push(s)
  }
  if (opts.socket) {
    fs.rmSync(opts.socket, { force: true })
    const s = http.createServer((req, res) => void handler(gw, 'socket', undefined, opts.log)(req, res))
    const old = process.umask(0o177)
    try {
      await up(s, () => s.listen(opts.socket))
    } finally {
      process.umask(old)
    }
    fs.chmodSync(opts.socket, 0o600)
    servers.push(s)
  }
  return { close: async () => void (await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined)))))) }
}
