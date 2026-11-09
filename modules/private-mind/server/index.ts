/**
 * The private-mind module (design section 5): one mind across this person's
 * home machines. Knowledge syncs through a central node; working detail stays
 * home and only pointers travel; nothing ever passes a gateway.
 *
 * Inert until enabled: without mind.json it does nothing, and with it nothing
 * syncs until `enabled` is true on that node (27 Oct 2026). It never runs on
 * a gateway node at all (design 5.7, the third of three guards).
 */
import type { CortexModule, ModuleCtx, ModuleHealth } from '../../../core/ctx.js'
import { machineId } from '../../../core/machineId.js'
import { shapeRule } from './classify.js'
import { configFile, loadConfig, type MindConfig } from './config.js'
import { short } from './commits.js'
import { MindService, MIND_ROLE, type MindState_ } from './service.js'
import { markHost, ONESHOT_ENV, unmarkHost } from './oneshot.js'
import { loadState } from './state.js'
import { MindStore } from './store.js'
import type { Ports } from './sync.js'

export const MIND_STATE_ADDRESS = 'mind:state'

let config: MindConfig | undefined
let problem: string | undefined
let stopClassifier: (() => void) | undefined
let service: MindService | undefined
let mindStore: MindStore | undefined
let timers: NodeJS.Timeout[] = []
let joined: Promise<void> = Promise.resolve()
let dataDir: string | undefined

export const DRAIN_MS = 5_000

/** The sync service, on an enabled node: its member joined, its inbox drained, a round every syncEveryMin. */
const startService = (ctx: ModuleCtx, cfg: MindConfig): MindService | undefined => {
  const cap = <T>(id: string) => ctx.capabilities.get<T>(id)
  const need = ['memory.versionVector', 'memory.journalStream', 'memory.journalAdopt', 'memory.blockVector', 'memory.blockStream', 'memory.blockAdopt', 'memory.shapeOf', 'comms.send', 'comms.inbox', 'comms.markSeen', 'comms.ensureMember', 'comms.logRead', 'comms.logPublish', 'comms.nodes']
  const missing = need.filter((id) => !ctx.capabilities.has(id))
  if (missing.length) {
    problem = `enabled, but cannot sync without ${missing.join(', ')}`
    ctx.log(problem)
    return undefined
  }
  const self = machineId()
  mindStore = new MindStore(ctx.dataDir)
  const ports: Ports = {
    versionVector: cap('memory.versionVector')!,
    journalStream: cap('memory.journalStream')!,
    journalAdopt: cap('memory.journalAdopt')!,
    blockVector: cap('memory.blockVector')!,
    blockStream: cap('memory.blockStream')!,
    blockAdopt: cap('memory.blockAdopt')!,
    sessionRoles: cap('comms.sessionRoles'),
    sessionInfo: cap('memory.sessionInfo'),
    shapeOf: cap('memory.shapeOf')!,
  }
  const read = cap<(address: string) => { payload: string }[]>('comms.logRead')!
  const publish = cap<(kind: string, address: string, payload: string, key?: string) => unknown>('comms.logPublish')!
  // A mind is a source only over a home route: a node reached only through a gateway is no source at all.
  const meshStatus = cap<() => { nodes?: { node: string; roles: string[]; homeHops?: number }[] } | undefined>('comms.nodes')!
  const svc: MindService = new MindService({
    self,
    cfg,
    dataDir: ctx.dataDir,
    store: mindStore,
    ports,
    comms: {
      send: cap('comms.send')!,
      inbox: cap('comms.inbox')!,
      markSeen: cap('comms.markSeen')!,
      mindNodes: () => (meshStatus()?.nodes ?? []).filter((n) => n.roles.includes(MIND_ROLE) && n.homeHops !== undefined).map((n) => n.node),
    },
    peers: () =>
      read(MIND_STATE_ADDRESS).flatMap((r) => {
        try {
          return [JSON.parse(r.payload) as MindState_]
        } catch {
          return []
        }
      }),
    publish: () => void publish('mind-state', MIND_STATE_ADDRESS, JSON.stringify(svc.gossip()), self),
    log: ctx.log,
  })
  joined = cap<(role: string, member: string) => Promise<string>>('comms.ensureMember')!(MIND_ROLE, svc.member)
    .then(() => void publish('mind-state', MIND_STATE_ADDRESS, JSON.stringify(svc.gossip()), self))
    .catch((err: unknown) => ctx.log(`private mind: the ${MIND_ROLE} member could not join: ${(err as Error).message}`))
  // A one-shot (cortex-mind sync) runs its round itself and exits; only a long-running host keeps timers.
  if (process.env[ONESHOT_ENV] === '1') return svc
  const guard = (what: string, fn: () => Promise<unknown>) => () => void fn().catch((err: unknown) => ctx.log(`private mind: ${what} failed: ${(err as Error).message}`))
  timers = [setInterval(guard('drain', () => svc.drain()), DRAIN_MS), setInterval(guard('sync round', () => svc.round()), cfg.syncEveryMin * 60_000)]
  for (const t of timers) t.unref()
  markHost(ctx.dataDir)
  return svc
}

/** The node's intent, from comms; a node whose comms cannot say is an ordinary home node. */
const intentHere = (ctx: ModuleCtx): string => ctx.capabilities.get<() => string>('comms.intent')?.() ?? 'node'

const rolesHere = (cfg: MindConfig, node: string): string[] => [...(cfg.central === node ? ['central'] : []), ...(cfg.archival === node ? ['archival'] : [])]

const mod: CortexModule = {
  start(ctx) {
    config = undefined
    problem = undefined
    if (intentHere(ctx) === 'gateway') {
      // Every module is installed everywhere; on a gateway this one simply never runs. Not a fault, so no warning.
      problem = 'not run here: private mind never runs on a gateway node'
      return
    }
    try {
      config = loadConfig(ctx.dataDir)
    } catch (err) {
      problem = (err as Error).message
      ctx.log(problem)
      return
    }
    if (!config) {
      problem = `not configured: no ${configFile(ctx.dataDir)}`
      return
    }
    const register = ctx.capabilities.get<(fn: (r: { shape: never }) => 'working' | undefined) => () => void>('memory.classifier')
    stopClassifier = register?.(shapeRule(config) as never)
    ctx.capabilities.provide('private-mind.config', () => config)
    ctx.capabilities.provide('private-mind.status', () => ({ ...loadState(ctx.dataDir), enabled: config!.enabled, central: config!.central, archival: config!.archival }))
    if (!config.enabled) {
      ctx.log(`configured, not enabled: nothing syncs (central ${config.central ?? 'unset'})`)
      return
    }
    service = startService(ctx, config)
    dataDir = ctx.dataDir
    ctx.capabilities.provide('private-mind.syncOnce', async (o?: Parameters<MindService['syncOnce']>[0]) => {
      if (!service) return { ran: false, why: problem ?? 'not running' }
      await joined
      return { ran: true, ...(await service.syncOnce(o)) }
    })
    if (service && process.env[ONESHOT_ENV] !== '1') ctx.log(`enabled: member ${service.member}, central ${config.central ?? 'unset'}, a round every ${config.syncEveryMin} min`)
  },

  stop() {
    for (const t of timers) clearInterval(t)
    if (timers.length && dataDir) unmarkHost(dataDir)
    timers = []
    service = undefined
    mindStore?.close()
    mindStore = undefined
    stopClassifier?.()
    stopClassifier = undefined
    config = undefined
  },

  status(ctx): ModuleHealth {
    if (!config) return { summary: problem ?? 'not running', ...(problem && !problem.startsWith('not ') ? { warnings: [problem] } : {}) }
    const s = loadState(ctx.dataDir)
    const node = machineId()
    const roles = rolesHere(config, node)
    if (problem) return { summary: problem, warnings: [problem] }
    if (service?.refused) return { summary: 'enabled, NOT syncing: this node runs under an id others already hold', warnings: [service.refused] }
    const head = s.commits[0] ? `at ${short(s.commits[0].id)}${s.base ? ` on central ${short(s.base)}` : ''}` : 'no sync yet'
    return {
      summary: `${config.enabled ? 'enabled' : 'configured, NOT enabled (no sync until enabled)'}; ${roles.length ? roles.join(' and ') : `central ${config.central ?? 'unset'}`}; ${head}${s.lastSyncAt ? `; last sync ${new Date(s.lastSyncAt).toISOString().slice(0, 16)}Z` : ''}`,
      ...(s.degraded ? { warnings: ['degraded: central unreachable, synced from a peer; a full reconcile follows when it is back'] } : {}),
      ...(config.enabled && !config.central ? { warnings: ['enabled with no central node set'] } : {}),
      ...(problem ? { warnings: [problem] } : {}),
    }
  },
}
export default mod
