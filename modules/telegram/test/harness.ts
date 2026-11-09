/** Fakes and a gateway builder for the telegram tests: a temp store, a fake clock, fake channels and a fake mesh. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'

import { FakeChannel } from '../server/channel.js'
import { parseConfig, type Config } from '../server/config.js'
import { openDb } from '../server/db.js'
import { Gateway, type MeshPort } from '../server/gateway.js'

const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
export const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-telegram-'))
  dirs.push(d)
  return d
}

export class FakeClock {
  t = Date.parse('2026-09-28T10:00:00Z')
  now = () => this.t
  advance(seconds: number) {
    this.t += seconds * 1000
  }
}

export class FakeMesh implements MeshPort {
  sent: { to: string; body: string; files?: string[]; awaits?: { key: string; how: string } }[] = []
  up = true
  constructor(
    public known: string[] = ['ops-dev', 'globex-dev'],
    public live: string[] = ['node-a:ops-dev', 'node-b:globex-dev'],
  ) {}
  async send(to: string, body: string, files?: string[], awaits?: { key: string; how: string }) {
    if (!this.up) return false
    this.sent.push({ to, body, ...(files ? { files } : {}), ...(awaits ? { awaits } : {}) })
    return true
  }
  roles() {
    if (!this.up) return []
    return this.known
  }
  liveRoles() {
    return this.up ? this.live : []
  }
}

export const OPERATOR = '12345'

export const config = (over: Record<string, unknown> = {}): Config =>
  parseConfig({
    http: { publishToken: { from: 'env', name: 'TG_PUBLISH' } },
    owners: { known: ['acme-dev'] },
    bots: [{ id: 'dev', default: true, identity: { username: '@test_bot' }, token: { from: 'env', name: 'TG_DEV' }, operators: [{ name: 'alex', chat: { from: 'env', name: 'TG_CHAT' } }], fallbackTo: 'alex', poll: true }],
    ...over,
  })

export const make = (o: { config?: Config; channels?: Record<string, FakeChannel>; mesh?: FakeMesh; operators?: Record<string, { name: string; chatId: string }[]>; dir?: string; emit?: (p: unknown) => void } = {}) => {
  const clock = new FakeClock()
  const cfg = o.config ?? config()
  const mesh = o.mesh ?? new FakeMesh()
  const channels = o.channels ?? Object.fromEntries(cfg.bots.map((b) => [b.id, new FakeChannel()]))
  const dir = o.dir ?? tmp()
  const db = openDb(path.join(dir, 'telegram.sqlite'))
  const gw = new Gateway({
    db,
    config: cfg,
    bots: cfg.bots.map((b) => ({ config: b, channel: channels[b.id]!, operators: o.operators?.[b.id] ?? [{ name: 'alex', chatId: OPERATOR }] })),
    mesh,
    clock: clock.now,
    emit: o.emit,
  })
  return { gw, clock, mesh, channel: channels.dev!, channels, db, dir, cfg }
}

let nextUpdate = 1
export const update = (text: string, o: { chat?: string; from?: string; replyTo?: number; replyText?: string; id?: number; messageId?: number } = {}) => ({
  update_id: o.id ?? nextUpdate++,
  message: {
    message_id: o.messageId ?? 1,
    chat: { id: o.chat ?? OPERATOR },
    from: { id: o.from ?? OPERATOR },
    text,
    ...(o.replyTo ? { reply_to_message: { message_id: o.replyTo, text: o.replyText ?? '' } } : {}),
  },
})
