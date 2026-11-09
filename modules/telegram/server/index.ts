/**
 * The telegram module: operator notifications over Telegram bots. It runs only in
 * the Cortex host (`runs: host`), on the one node configured for it. Without
 * a telegram.json in its data dir it starts and does nothing.
 *
 * Comms is optional: without it the HTTP intake and the socket still work, and
 * owners must be pinned or known.
 */
import type { CortexModule, ModuleCtx, ModuleHealth } from '../../../core/ctx.js'
import type { CommandPort, CommandMessage } from './commands.js'
import { configFile, loadConfig } from './config.js'
import type { MeshPort } from './gateway.js'
import { TelegramService } from './service.js'

let service: TelegramService | undefined
let problem: string | undefined

type Send = (from: string, to: string, body: string, opts?: { queueAnyway?: boolean; files?: string[]; silent?: boolean; awaits?: { key: string; how: string } }) => Promise<{ ok: boolean }>
type MeshRoles = (opts?: { live?: boolean }) => { role: string; address: string }[]

const ports = (ctx: ModuleCtx, member: string): { mesh?: MeshPort; commands?: CommandPort } => {
  const send = ctx.capabilities.get<Send>('comms.send')
  const inbox = ctx.capabilities.get<(m: string) => Promise<CommandMessage[]>>('comms.inbox')
  const markSeen = ctx.capabilities.get<(m: string, ids: string[]) => void>('comms.markSeen')
  const meshRoles = ctx.capabilities.get<MeshRoles>('comms.meshRoles')
  if (!send) return {}
  const mesh: MeshPort = {
    send: async (to, body, files, awaits) => (await send(member, to, body, { queueAnyway: true, files, awaits })).ok,
    roles: () => [...new Set((meshRoles?.() ?? []).map((r) => r.role))],
    liveRoles: () => (meshRoles?.({ live: true }) ?? []).map((r) => r.address),
  }
  const commands: CommandPort | undefined =
    inbox && markSeen
      ? {
          inbox: () => inbox(member),
          markSeen: (ids) => markSeen(member, ids),
          // Silent: a result is for the CLI waiting on it, never for the session's watcher or prompt.
          reply: async (to, body, files) => (await send(member, to, body, { queueAnyway: true, files, silent: true })).ok,
        }
      : undefined
  return { mesh, commands }
}

const mod: CortexModule = {
  async start(ctx) {
    let config
    try {
      config = loadConfig(ctx.dataDir)
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err)
      ctx.log(problem)
      return
    }
    if (!config) {
      problem = `not configured: no ${configFile(ctx.dataDir)}. The module has no built-in bot: run cortex-telegram-admin init (modules/telegram/README.md)`
      return
    }
    service = new TelegramService({
      dataDir: ctx.dataDir,
      config,
      ...ports(ctx, config.member),
      emit: (payload) => void ctx.events.publish('telegram.inbound', payload),
      log: ctx.log,
    })
    for (const w of service.warnings) ctx.log(w)
    ctx.capabilities.provide('telegram.publish', (p: Parameters<TelegramService['gateway']['publish']>[0]) => service!.gateway.publish(p))
    ctx.capabilities.provide('telegram.send', (p: Parameters<TelegramService['gateway']['send']>[0]) => service!.gateway.send(p))
    ctx.capabilities.provide('telegram.replies', (q: Parameters<TelegramService['gateway']['replies']>[0]) => service!.gateway.replies(q))
    ctx.capabilities.provide('telegram.claim', (id: number, sender: string) => service!.gateway.claim(id, sender))
    ctx.capabilities.provide('telegram.status', () => service!.gateway.health(true))
    await service.start()
  },

  async stop() {
    await service?.stop()
    service = undefined
  },

  status(): ModuleHealth {
    if (!service) return { summary: problem ?? 'not running', ...(problem && !problem.startsWith('not configured') ? { warnings: [problem] } : {}) }
    const h = service.gateway.health(true)
    const warnings = [...service.warnings]
    for (const i of service.identities.values()) if (i.state === 'unverified' && i.reason) warnings.push(i.reason)
    for (const b of h.bots) {
      const p = service.pollers.get(b.bot)
      if (p && p.state !== 'polling' && p.state !== 'off') warnings.push(`bot ${b.bot}: poller ${p.state}${p.reason ? ` (${p.reason})` : ''}`)
      for (const a of b.alerts) warnings.push(`bot ${b.bot}: alert open: ${a}`)
      if (b.unnotified_inbound) warnings.push(`bot ${b.bot}: ${b.unnotified_inbound} operator message(s) whose owner was never told`)
    }
    return {
      summary: h.bots
        .map((b) => `${b.bot}: items ${JSON.stringify(b.items)}, outbound ${JSON.stringify(b.outbound)}, unclaimed ${b.unclaimed_inbound}, info to review ${b.info_unreviewed}, poller ${service!.pollers.get(b.bot)?.state ?? 'off'}`)
        .join('; '),
      ...(warnings.length ? { warnings } : {}),
    }
  },
}
export default mod
