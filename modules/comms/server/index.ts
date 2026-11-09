/**
 * The comms module: role mailboxes, member identity, claims.
 *
 * Most of the work happens in the two hook subscribers and the `cortex-role`
 * CLI. `start` registers the declared capabilities so another module can send
 * and read role messages without knowing how comms is built; a capability that
 * is declared and never provided is the declared-but-inert shape this project
 * keeps finding, so every id in `provides` is backed here.
 */
import fs from 'node:fs'
import path from 'node:path'

import type { CortexModule, ModuleCtx, ModuleHealth } from '../../../core/ctx.js'
import { metaFor, openComms } from './session.js'
import { RENAMED } from '../../../core/sessionNames.js'
import { followRename, heldRenames, type RenamedPayload } from './renames.js'
import { machineId } from '../../../core/machineId.js'
import { meshDir } from '../../../core/paths.js'
import { MeshLog } from './mesh/log.js'
import { meshSummary, startMesh, stopMesh } from './mesh/part.js'
import { meshView } from './mesh/view.js'
import { localRoles } from './meshBridge.js'
import { meshRoles } from './meshWho.js'

const localMembers = (ctx: ModuleCtx): string[] => {
  try {
    return fs
      .readdirSync(path.join(ctx.dataDir, 'members'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort()
  } catch {
    return []
  }
}

/** Where messages travel: the mesh log, or (V1 transition only) a bus server. */
const bus = () => 'bus: the mesh log'

export type SessionWriter = { bound: false } | { bound: true; member: string; roles: string[] | undefined }

const mod: CortexModule = {
  start(ctx) {
    startMesh(ctx)
    const { comms, local } = openComms(ctx.dataDir)
    // Core's session naming: the member follows a rename, and [role] joins under it.
    ctx.events.subscribe(RENAMED, ctx.name, (p) =>
      followRename(ctx.dataDir, local, comms, p as RenamedPayload, metaFor({ cwd: process.cwd() })),
    )
    ctx.capabilities.provide('comms.send', (from: string, to: string, body: string, opts?: { notify?: boolean; queueAnyway?: boolean; files?: string[]; homeOnly?: boolean }) =>
      comms.send(from, to, body, opts),
    )
    ctx.capabilities.provide('comms.inbox', (member: string, opts?: Parameters<typeof comms.inbox>[1]) => comms.inbox(member, opts))
    // A member waiting on an answer to something it sent (telegram's await) marks it answered.
    ctx.capabilities.provide('comms.markAwait', (member: string, key: string, state: Parameters<typeof local.markAwait>[2]) => local.markAwait(member, key, state))
    ctx.capabilities.provide('comms.markSeen', (member: string, ids: string[]) => comms.markSeen(member, ids))
    ctx.capabilities.provide('comms.claim', (member: string, msgId: string) => comms.claim(member, msgId))
    ctx.capabilities.provide('comms.reply', (from: string, msgId: string, body: string) => comms.reply(from, msgId, body))
    ctx.capabilities.provide('comms.workContext', (member: string) => comms.workContext(member))
    // Who wrote in a session, for deciding whether its memories are private to a role:
    // never bound to a member; bound, with the member's roles; or bound to a member no longer known (roles undefined).
    ctx.capabilities.provide('comms.sessionRoles', async (sessionId: string): Promise<SessionWriter> => {
      const member = local.sessionMember(sessionId)
      if (!member) return { bound: false }
      return { bound: true, member, roles: await comms.rolesOf(member) }
    })
    // A service member (private mind's) joins its role here, marked kind=service; joining again changes nothing.
    ctx.capabilities.provide('comms.ensureMember', async (role: string, member: string) => {
      if (!(await comms.rolesOf(member))?.includes(role)) await comms.join(role, { as: member, create: true })
      await comms.set(member, { kind: 'service' })
      return member
    })
    // A service member (private mind's) leaves its role when its module is taken out.
    ctx.capabilities.provide('comms.leaveRole', (role: string, member: string) => comms.leaveRole(role, member))
    ctx.capabilities.provide('comms.roles', () => comms.roles())
    // Every role on the mesh, with liveness (who --mesh); empty without the mesh.
    ctx.capabilities.provide('comms.meshRoles', (opts?: { live?: boolean }) => {
      const log = new MeshLog(meshDir(), machineId())
      try {
        return meshRoles(meshView(meshDir(), machineId()), localRoles(log)(), opts)
      } finally {
        log.close()
      }
    })
  },

  stop() {
    stopMesh()
  },

  /** Local facts only: status must not block on the network. */
  status(ctx): ModuleHealth {
    const members = localMembers(ctx)
    const held = Object.entries(heldRenames(ctx.dataDir))
    return {
      ...(held.length
        ? { warnings: held.map(([m, h]) => `rename held: ${m} becomes ${h.to} once its claimed work is released (${h.why}; since ${new Date(h.since).toISOString().slice(0, 16)}Z); or /cortex-rename ${h.to} --force`) }
        : {}),
      summary: `${
        members.length ? `${members.length} member(s) on this machine: ${members.join(', ')}` : 'no members on this machine yet (join with /cortex-role join <role>)'
      }; ${bus()}; mesh: ${meshSummary()}`,
    }
  },
}
export default mod
