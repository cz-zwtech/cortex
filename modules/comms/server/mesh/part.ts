/**
 * The mesh, comms' link to other machines: the record log every message is written to, and the
 * daemon that streams it between nodes. Comms starts it; nothing else treats it as separate.
 * Its data stays where it always was, in the mesh dir (core's meshDir), not in comms' data dir.
 */
import type { ModuleCtx } from '../../../../core/ctx.js'
import { machineId } from '../../../../core/machineId.js'
import { meshDir } from '../../../../core/paths.js'
import { AdoptedWatch } from './adopted.js'
import { isRunning, meshPort, readStatus } from './control.js'
import { MeshLog, type MeshRecord } from './log.js'
import { effectiveNodeConfig } from './nodeConfig.js'
import { readPeers } from './peers.js'

let log: MeshLog | undefined
let adopted: AdoptedWatch | undefined

export const startMesh = (ctx: Pick<ModuleCtx, 'capabilities'>): void => {
  log = new MeshLog(meshDir(), machineId())
  ctx.capabilities.provide('comms.logPublish', (kind: string, address: string, payload: string, key?: string) => log!.append(kind, address, payload, key))
  ctx.capabilities.provide('comms.logRead', (address: string) => log!.read(address))
  ctx.capabilities.provide('comms.nodes', () => readStatus(meshDir()))
  // node, relay or gateway: what this node is, from its config (a gateway runs no private mind, for one).
  ctx.capabilities.provide('comms.intent', () => effectiveNodeConfig(meshDir()).intent ?? 'node')
  // Told of records the daemon adopted from other machines, by kind; returns the way to stop listening.
  ctx.capabilities.provide('comms.onAdopted', (kinds: string[], fn: (records: MeshRecord[]) => void) => (adopted ??= new AdoptedWatch(log!)).subscribe(kinds, fn))
}

export const stopMesh = (): void => {
  adopted?.close()
  adopted = undefined
  log?.close()
  log = undefined
}

/** One line for comms' status: the daemon, this node, its links. */
export const meshSummary = (): string => {
  const dir = meshDir()
  const s = readStatus(dir)
  const ready = s?.links.filter((l) => l.live && l.ready).length ?? 0
  const configured = readPeers(dir).length
  return `${isRunning(dir) ? `daemon running on :${s?.port ?? meshPort(dir)}` : 'daemon not running'}; node ${machineId()}; ${
    ready || configured ? `${ready} node(s) linked, ${configured} configured` : 'no links (single machine)'
  }${s?.roles?.length ? '' : '; no roles yet, so unvalidated'}`
}
