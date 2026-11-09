// A stand-in Telegram Bot API for the telegram sims (CKN_TELEGRAM_API). Per token:
//   getMe          the bot's username: the token with dashes as underscores, plus _bot (fake-dev: fake_dev_bot)
//   sendMessage    recorded to <dir>/<token>-sent.jsonl, message ids from 5001
//   getUpdates     serves queued updates with update_id >= offset; 409 while <dir>/<token>.conflict exists
//   POST /control/<token>/push   queue an update (the body is the update JSON)
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const [port, dir] = [Number(process.argv[2] ?? 8081), process.argv[3] ?? '/tmp/tg']
fs.mkdirSync(dir, { recursive: true })
const queues = new Map()
let next = 5000
const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
http
  .createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      let m = /^\/control\/([^/]+)\/push$/.exec(req.url)
      if (m) {
        if (!queues.has(m[1])) queues.set(m[1], [])
        queues.get(m[1]).push(body)
        return json(res, 200, { ok: true })
      }
      m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url)
      if (!m) return json(res, 404, { ok: false })
      const [, token, method] = m
      if (method === 'getMe') return json(res, 200, { ok: true, result: { id: 1, is_bot: true, username: `${token.replace(/-/g, '_')}_bot` } })
      if (method === 'sendMessage') {
        const id = ++next
        fs.appendFileSync(path.join(dir, `${token}-sent.jsonl`), JSON.stringify({ message_id: id, chat: String(body.chat_id), text: body.text, ...(body.reply_parameters ? { reply_to: body.reply_parameters.message_id } : {}) }) + '\n')
        return json(res, 200, { ok: true, result: { message_id: id } })
      }
      if (method === 'getUpdates') {
        if (fs.existsSync(path.join(dir, `${token}.conflict`))) return json(res, 409, { ok: false, description: 'Conflict: terminated by other getUpdates request' })
        const q = (queues.get(token) ?? []).filter((u) => u.update_id >= (body.offset ?? 0))
        queues.set(token, [])
        if (q.length) return json(res, 200, { ok: true, result: q })
        // A short long-poll, so a stopping host is not held for long.
        return setTimeout(() => json(res, 200, { ok: true, result: [] }), Math.min(1000, (body.timeout ?? 0) * 1000))
      }
      return json(res, 404, { ok: false, description: 'no such method' })
    })
  })
  .listen(port, '127.0.0.1')
