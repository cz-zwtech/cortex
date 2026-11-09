/**
 * The running service: one gateway, its dispatcher tick, a poller per bot that
 * polls, the HTTP surfaces, and the comms command handler. Built from config,
 * the environment (tokens and chat ids, filled by bao-run) and injected ports,
 * so a test assembles the same thing with fakes.
 *
 * Exactly one getUpdates consumer per token: a per-bot lock file in the data
 * dir (pid inside, taken over only from a dead pid), and a bot does not poll
 * while one of its conflictingUnits is active. A conflict or a dead token
 * stops that bot's poller with one alert; the other bots carry on.
 */
import { describeRef, resolver, type Resolve } from './secrets.js'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { DryRunChannel, TelegramChannel, type Channel } from './channel.js'
import { handleCommands, type CommandPort } from './commands.js'
import type { BotConfig, Config } from './config.js'
import { openDb, type Db } from './db.js'
import { Gateway, type BotRuntime, type MeshPort, type Operator } from './gateway.js'
import { listen, type Listeners } from './http.js'

export type ServiceDeps = {
  dataDir: string
  config: Config
  env?: NodeJS.ProcessEnv
  mesh?: MeshPort
  commands?: CommandPort
  /** How long to wait before asking getMe again when Telegram did not answer. */
  verifyRetryMs?: number
  /** Resolve a secret reference; defaults to env, or OpenBao through bao-run (secrets.ts). */
  resolve?: Resolve
  /** Build a bot's channel; defaults to Telegram (or dry-run) with its resolved token. */
  channel?: (bot: BotConfig, token: string) => Channel
  /** Is a systemd user unit active? Injected for tests. */
  unitActive?: (unit: string) => boolean
  emit?: (payload: { bot: string; inboundId: number; route: string }) => void
  clock?: () => number
  log: (m: string) => void
  /** Turn off the HTTP listeners (tests drive the handler directly). */
  http?: boolean
  pollTimeoutS?: number
}

export type PollerState = { bot: string; state: 'polling' | 'off' | 'waiting for a conflicting unit' | 'stopped' | 'locked by another process'; reason?: string }

const defaultUnitActive = (unit: string): boolean => {
  const r = spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf-8' })
  return ['active', 'activating', 'reloading'].includes((r.stdout ?? '').trim())
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Take the bot's poll lock, or say who holds it. */
export const takePollLock = (dataDir: string, bot: string): { ok: true; release: () => void } | { ok: false; holder: number } => {
  const file = path.join(dataDir, `poll-${bot}.lock`)
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' })
      return { ok: true, release: () => fs.rmSync(file, { force: true }) }
    } catch {
      const holder = Number(fs.readFileSync(file, 'utf-8').trim())
      if (holder && holder !== process.pid && alive(holder)) return { ok: false, holder }
      fs.rmSync(file, { force: true })
    }
  }
  return { ok: false, holder: -1 }
}

export class TelegramService {
  readonly gateway: Gateway
  readonly db: Db
  readonly pollers = new Map<string, PollerState>()
  readonly warnings: string[] = []
  #stopped = false
  // Stop ends long polls and sleeps through this, then waits for every loop and the tick in flight
  // before it closes the store: nothing may write to a closed store (a fault-isolation test).
  #abort = new AbortController()
  #running: Promise<unknown>[] = []
  #tickRun?: Promise<void>
  #timers: NodeJS.Timeout[] = []
  #locks: (() => void)[] = []
  #http?: Listeners
  #deps: ServiceDeps
  #resolve: Resolve

  constructor(deps: ServiceDeps) {
    this.#deps = deps
    const resolve = deps.resolve ?? resolver(deps.env ?? process.env)
    this.#resolve = resolve
    fs.mkdirSync(deps.dataDir, { recursive: true, mode: 0o700 })
    this.db = openDb(path.join(deps.dataDir, 'telegram.sqlite'))
    const bots: BotRuntime[] = []
    for (const b of deps.config.bots) {
      const operators: Operator[] = []
      for (const o of b.operators) {
        const chatId = resolve(o.chat)
        if (chatId) operators.push({ name: o.name, chatId })
        else this.warnings.push(`bot ${b.id}: operator ${o.name} has no chat id (${describeRef(o.chat)} gave nothing)`)
      }
      // Refused, not degraded: a bot whose token source gives nothing does not run at all.
      const token = resolve(b.token) ?? ''
      if (!token && b.mode === 'live') {
        this.warnings.push(`bot ${b.id} is refused: no token from ${describeRef(b.token)}`)
        continue
      }
      let channel: Channel
      try {
        channel = deps.channel ? deps.channel(b, token) : b.mode === 'live' ? new TelegramChannel(token) : new DryRunChannel(path.join(deps.dataDir, `dry-run-${b.id}.jsonl`))
      } catch (err) {
        this.warnings.push(`bot ${b.id} is refused: ${err instanceof Error ? err.message : err} (${describeRef(b.token)})`)
        continue
      }
      bots.push({ config: b, channel, operators })
    }
    this.gateway = new Gateway({ db: this.db, config: deps.config, bots, mesh: deps.mesh, clock: deps.clock, emit: deps.emit, log: deps.log })
  }

  async start(): Promise<void> {
    const d = this.#deps
    const tick = async () => {
      if (this.#stopped) return
      try {
        await this.gateway.tick()
        if (d.commands) await handleCommands(this.gateway, d.commands, path.join(d.dataDir, 'out'), d.log)
      } catch (err) {
        d.log(`tick: ${err instanceof Error ? err.message : err}`)
      }
      if (!this.#stopped) this.#timers.push(setTimeout(() => void (this.#tickRun = tick()), d.config.tickSeconds * 1000))
    }
    this.#tickRun = tick()
    for (const b of this.gateway.bots) {
      const poll = () => {
        if (!b.config.poll) this.pollers.set(b.config.id, { bot: b.config.id, state: 'off' })
        else this.#running.push(this.#pollLoop(b.config).catch((err) => d.log(`poller ${b.config.id}: ${err instanceof Error ? err.message : err}`)))
      }
      // A live bot is confirmed as the configured one before anything is sent or polled through it.
      if (b.config.mode !== 'live' || !b.channel.me) {
        poll()
        continue
      }
      b.verified = false
      this.#running.push(this.#verify(b).then((ok) => ok && poll()))
    }
    if (d.http !== false) {
      this.#http = await listen(this.gateway, {
        listen: d.config.http.listen,
        socket: path.join(d.dataDir, 'telegram.sock'),
        publishToken: d.config.http.publishToken ? this.#resolve(d.config.http.publishToken) : undefined,
        log: d.log,
      })
    }
  }

  /** Per bot: confirmed as configured, refused, or not yet reachable. */
  identities = new Map<string, { state: 'verified' | 'refused' | 'unverified'; reason?: string }>()

  /**
   * getMe must report the configured username. A mismatch refuses the bot for
   * good (a restart re-checks); Telegram unreachable retries each minute, and
   * the bot's messages wait meanwhile. Nothing is ever sent through a bot to
   * say it is the wrong one.
   */
  async #verify(b: BotRuntime): Promise<boolean> {
    const want = b.config.identity.username.replace(/^@/, '').toLowerCase()
    while (!this.#stopped) {
      try {
        const got = (await b.channel.me!()).replace(/^@/, '')
        if (got.toLowerCase() === want) {
          b.verified = true
          this.identities.set(b.config.id, { state: 'verified' })
          return true
        }
        const reason = `bot ${b.config.id} is refused: Telegram says its token is @${got}, the config names @${want}`
        this.identities.set(b.config.id, { state: 'refused', reason })
        this.warnings.push(reason)
        this.#deps.log(reason)
        return false
      } catch (err) {
        const reason = `bot ${b.config.id} is not confirmed yet (getMe: ${err instanceof Error ? err.message : String(err)}); its messages wait`
        this.identities.set(b.config.id, { state: 'unverified', reason })
        await new Promise<void>((r) => {
          const t = setTimeout(r, this.#deps.verifyRetryMs ?? 60_000)
          this.#timers.push(t)
          this.#abort.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true })
        })
      }
    }
    return false
  }

  async #pollLoop(b: BotConfig): Promise<void> {
    const d = this.#deps
    const unitActive = d.unitActive ?? defaultUnitActive
    const set = (state: PollerState['state'], reason?: string) => this.pollers.set(b.id, { bot: b.id, state, ...(reason ? { reason } : {}) })
    const sleep = (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms)
        this.#timers.push(t)
        this.#abort.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true })
      })
    const lock = takePollLock(d.dataDir, b.id)
    if (!lock.ok) {
      set('locked by another process', `pid ${lock.holder} holds poll-${b.id}.lock`)
      return
    }
    this.#locks.push(lock.release)
    while (!this.#stopped) {
      const busy = b.conflictingUnits.find((u) => unitActive(u))
      if (busy) {
        set('waiting for a conflicting unit', `${busy} is active`)
        await this.gateway.alert(b.id, 'unit', `the ${b.id} bot is not listening while ${busy} runs (one poller per token). Stop ${busy} to hand over.`)
        await sleep(60_000)
        continue
      }
      this.gateway.recovered(b.id, 'unit')
      set('polling')
      const r = await this.gateway.pollOnce(b.id, d.pollTimeoutS ?? 50, this.#abort.signal)
      if (this.#stopped) return
      if (r === 'stop') {
        set('stopped', 'a getUpdates conflict or a refused token; see the alert, fix it, restart cortex-host')
        return
      }
      if (r === 'error') await sleep(5_000)
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true
    this.#abort.abort()
    for (const t of this.#timers) clearTimeout(t)
    await Promise.allSettled([...this.#running, this.#tickRun])
    await this.#http?.close()
    for (const release of this.#locks) release()
    this.db.close()
  }
}
