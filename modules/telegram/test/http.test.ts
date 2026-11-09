import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { test } from 'node:test'

import { listen } from '../server/http.js'
import { make } from './harness.js'

type Res = { status: number; body: Record<string, unknown> }
const req = (o: { port?: number; socket?: string; method?: string; path: string; token?: string; body?: unknown; raw?: string }): Promise<Res> =>
  new Promise((ok, fail) => {
    const data = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body))
    const r = http.request(
      { ...(o.socket ? { socketPath: o.socket } : { host: '127.0.0.1', port: o.port }), method: o.method ?? 'GET', path: o.path, headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), 'content-type': 'application/json' } },
      (res) => {
        let s = ''
        res.on('data', (c) => (s += c))
        res.on('end', () => ok({ status: res.statusCode!, body: s ? JSON.parse(s) : {} }))
      },
    )
    r.on('error', fail)
    if (data !== undefined) r.write(data)
    r.end()
  })

const serve = async () => {
  const x = make()
  const port = await new Promise<number>((r) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => r(p))
    })
  })
  const socket = path.join(x.dir, 'telegram.sock')
  const l = await listen(x.gw, { listen: [`127.0.0.1:${port}`], socket, publishToken: 'pub-token', log: () => {} })
  return { ...x, port, socket, close: l.close }
}

const item = { source: 'gpu-check', owner: 'globex-dev', severity: 'action', title: 'GPU missing', body: 'details' }

test('LAN: health needs no token and holds counts only, no ids, offset or error text (addition D)', async () => {
  const s = await serve()
  try {
    const { id } = s.gw.publish({ ...item, severity: 'page' })
    s.db.prepare("UPDATE items SET state = 'failed' WHERE id = ?").run(id)
    const h = await req({ port: s.port, path: '/v1/health' })
    assert.equal(h.status, 200)
    const text = JSON.stringify(h.body)
    assert.ok(!text.includes(id!), 'no item ids')
    assert.ok(!/offset|last_error|failed_items|GPU/.test(text))
    const detail = await req({ socket: s.socket, path: '/v1/health' })
    assert.deepEqual((detail.body.bots as { failed_items: string[] }[])[0]!.failed_items, [id])
  } finally {
    await s.close()
  }
})

test('LAN: the publish token publishes and does nothing else; a wrong or missing token is 401', async () => {
  const s = await serve()
  try {
    assert.equal((await req({ port: s.port, method: 'POST', path: '/v1/items', token: 'pub-token', body: item })).status, 201)
    assert.equal((await req({ port: s.port, method: 'POST', path: '/v1/items', token: 'nope', body: item })).status, 401)
    assert.equal((await req({ port: s.port, method: 'POST', path: '/v1/items', body: item })).status, 401)
    for (const p of ['/v1/replies', '/v1/info/digest', '/v1/items/it_x']) assert.equal((await req({ port: s.port, path: p, token: 'pub-token' })).status, 403)
    assert.equal((await req({ port: s.port, method: 'POST', path: '/v1/send', token: 'pub-token', body: { sender: 'globex-dev', text: 'x' } })).status, 403)
  } finally {
    await s.close()
  }
})

test('socket: mode 0600, the full API, and a caller mistake is a 4xx, never a 500 (brief defects 5 and 6)', async () => {
  const s = await serve()
  try {
    assert.equal(fs.statSync(s.socket).mode & 0o777, 0o600)
    const pub = await req({ socket: s.socket, method: 'POST', path: '/v1/items', body: item })
    const id = pub.body.id as string
    assert.equal((await req({ socket: s.socket, path: `/v1/items/${id}` })).body.title, 'GPU missing')
    assert.equal((await req({ socket: s.socket, method: 'POST', path: `/v1/items/${id}/ack`, body: { session: 'globex-dev', resolution: 'handled' } })).body.state, 'acked')
    assert.equal((await req({ socket: s.socket, method: 'POST', path: '/v1/send', body: { sender: 'globex-dev', text: '' } })).status, 400)
    assert.equal((await req({ socket: s.socket, method: 'POST', path: '/v1/send', body: { sender: 'stranger', text: 'hi' } })).status, 403)
    assert.equal((await req({ socket: s.socket, method: 'POST', path: '/v1/items', raw: '[]' })).status, 400)
    assert.equal((await req({ socket: s.socket, method: 'POST', path: '/v1/items', raw: '{bad' })).status, 400)
    assert.equal((await req({ socket: s.socket, method: 'POST', path: '/v1/items', body: { ...item, title: 7 } })).status, 400)
    assert.equal((await req({ socket: s.socket, method: 'POST', path: '/v1/inbound/abc/claim', body: { session: 'globex-dev' } })).status, 400)
    assert.equal((await req({ socket: s.socket, path: '/v1/replies?id=abc' })).status, 400)
    assert.equal((await req({ socket: s.socket, path: '/v1/nope' })).status, 404)
    const reviewed = await req({ socket: s.socket, method: 'POST', path: '/v1/info/reviewed', body: { ids: 'x', by: 'pm' } })
    assert.equal(reviewed.status, 400)
  } finally {
    await s.close()
  }
})

test('socket: send is idempotent per sender and key, scoped per sender (addition D)', async () => {
  const s = await serve()
  try {
    const a = await req({ socket: s.socket, method: 'POST', path: '/v1/send', body: { sender: 'globex-dev', text: 'q', idempotency_key: 'k1' } })
    const b = await req({ socket: s.socket, method: 'POST', path: '/v1/send', body: { sender: 'globex-dev', text: 'q', idempotency_key: 'k1' } })
    const c = await req({ socket: s.socket, method: 'POST', path: '/v1/send', body: { sender: 'ops-dev', text: 'q', idempotency_key: 'k1' } })
    assert.equal(a.body.id, b.body.id)
    assert.notEqual(a.body.id, c.body.id, 'another sender with the same key is its own message')
    assert.equal(s.channel.sent.length, 2)
    assert.equal(a.body.message_id, s.channel.sent[0]!.message_id)
  } finally {
    await s.close()
  }
})

test('socket: a failed session send can be retried by its outbound id (brief defect 10)', async () => {
  const s = await serve()
  try {
    const { ChannelError } = await import('../server/channel.js')
    s.channel.failNext.push(new ChannelError('HTTP 400', true, undefined, 400))
    const a = await req({ socket: s.socket, method: 'POST', path: '/v1/send', body: { sender: 'globex-dev', text: 'q' } })
    assert.equal(a.body.state, 'failed')
    const r = await req({ socket: s.socket, method: 'POST', path: `/v1/outbound/${a.body.id}/retry` })
    assert.equal(r.body.state, 'sent')
  } finally {
    await s.close()
  }
})
