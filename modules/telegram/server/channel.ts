/**
 * A chat channel a bot speaks through. Telegram is the first; another chat
 * service is a new adapter, nothing else.
 *
 * Errors carry whether they are permanent (a bad token, a chat the bot cannot
 * reach) or transient (rate limits, the network), and a getUpdates conflict
 * (another process polling the same token) is its own kind, because it stops
 * the poller rather than the send path.
 */
import fs from 'node:fs'

import { assertCanSend } from './guard.js'

export type Update = {
  update_id: number
  message?: InboundMessage
  edited_message?: InboundMessage
}
export type InboundMessage = {
  message_id?: number
  chat?: { id?: number | string }
  from?: { id?: number | string }
  text?: string
  caption?: string
  reply_to_message?: { message_id?: number; text?: string }
}

export class ChannelError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly retryAfterS?: number,
    readonly status?: number,
  ) {
    super(message)
  }
}
/** Another process is polling this token (Telegram 409). */
export class PollConflict extends ChannelError {
  constructor() {
    super('another process is polling this bot token (getUpdates conflict)', true, undefined, 409)
  }
}

export interface Channel {
  /** `replyTo`: the Telegram message this answers, so it threads under it in the chat. */
  send(chat: string, text: string, replyTo?: number): Promise<number>
  /** `signal` ends a long poll early, when the service stops. */
  poll(offset: number, timeoutS: number, signal?: AbortSignal): Promise<Update[]>
  /** The username Telegram reports for this token (getMe). Absent on channels that are not Telegram. */
  me?(): Promise<string>
}

export const TELEGRAM_LIMIT = 4096
const PERMANENT = new Set([400, 401, 403, 404])

export class TelegramChannel implements Channel {
  #last = 0
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
    private minIntervalMs = 1000,
    // A stand-in Telegram for the container sims; never set in production.
    private api = process.env.CKN_TELEGRAM_API ?? 'https://api.telegram.org',
  ) {
    // A loopback stand-in (the sims', a test's) is never Telegram: the guard is for the real API.
    if (fetchImpl === fetch && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(api)) assertCanSend('Telegram channel')
    if (!token) throw new Error('no bot token in the environment')
  }

  async #call<T>(method: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.api}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      // Never the URL: the token is in it.
      throw new ChannelError(`${method}: network error (${err instanceof Error ? err.name : 'unknown'})`, false)
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }
    if (res.ok && json.ok) return json.result as T
    if (res.status === 409 && method === 'getUpdates') throw new PollConflict()
    const why = `${method}: HTTP ${res.status}${json.description ? ` ${json.description}` : ''}`
    throw new ChannelError(why, PERMANENT.has(res.status), json.parameters?.retry_after, res.status)
  }

  async me(): Promise<string> {
    return (await this.#call<{ username: string }>('getMe', {}, 10_000)).username
  }

  async send(chat: string, text: string, replyTo?: number): Promise<number> {
    const wait = this.#last + this.minIntervalMs - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.#last = Date.now()
    // Plain text on purpose: no parse_mode, so nothing in a message is markup. A reply threads under the
    // operator's message, and is still sent if that message was deleted.
    const reply = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}
    const r = await this.#call<{ message_id: number }>('sendMessage', { chat_id: chat, text: text.slice(0, TELEGRAM_LIMIT), ...reply }, 20_000)
    return r.message_id
  }

  poll(offset: number, timeoutS: number, signal?: AbortSignal): Promise<Update[]> {
    return this.#call<Update[]>('getUpdates', { offset, timeout: timeoutS, allowed_updates: ['message', 'edited_message'] }, (timeoutS + 10) * 1000, signal)
  }
}

/** Records what would be sent; cannot poll. */
export class DryRunChannel implements Channel {
  #next: number
  constructor(private file: string) {
    this.#next = Date.now()
  }
  async send(chat: string, text: string, replyTo?: number): Promise<number> {
    const id = ++this.#next
    fs.appendFileSync(this.file, JSON.stringify({ message_id: id, chat, text, ...(replyTo ? { reply_to: replyTo } : {}) }) + '\n')
    return id
  }
  async poll(): Promise<Update[]> {
    throw new ChannelError('a dry-run channel cannot poll', true)
  }
}

/** For tests: records sends, serves queued updates, fails on demand. */
export class FakeChannel implements Channel {
  /** What getMe reports; a test sets another to see a mismatch refused. */
  username = 'test_bot'
  meFail: Error[] = []
  async me(): Promise<string> {
    const f = this.meFail.shift()
    if (f) throw f
    return this.username
  }
  sent: { message_id: number; chat: string; text: string; reply_to?: number }[] = []
  updates: Update[] = []
  failNext: Error[] = []
  pollFail: Error[] = []
  #next = 1000
  async send(chat: string, text: string, replyTo?: number): Promise<number> {
    const f = this.failNext.shift()
    if (f) throw f
    const id = ++this.#next
    this.sent.push({ message_id: id, chat, text, ...(replyTo ? { reply_to: replyTo } : {}) })
    return id
  }
  async poll(offset: number): Promise<Update[]> {
    // One turn of the event loop per poll, as a real long poll gives: an instant fake would loop on
    // microtasks alone and starve every timer, a test's waits included.
    await new Promise((r) => setImmediate(r))
    const f = this.pollFail.shift()
    if (f) throw f
    const batch = this.updates.filter((u) => u.update_id >= offset)
    this.updates = []
    return batch
  }
}
