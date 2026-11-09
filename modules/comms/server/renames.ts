/**
 * Comms follows a session rename (core's `session.renamed`, 19 Oct).
 *
 * The member takes the new name in the same roles. While the member owns
 * claimed work, that would leave the work with a name nobody holds, so the
 * rename is HELD, not dropped: recorded here, completed by itself once
 * the last claim is released, said once, and listed in status until then.
 * `--force` renames at once.
 *
 * comms extends core's command with `[role]`: after following the rename, the
 * session joins that role under its name.
 */
import fs from 'node:fs'
import path from 'node:path'

import type { Comms } from './comms.js'
import { watchInstruction } from './hooks.js'
import { cliPath } from './session.js'
import { watchStatus } from './watchState.js'
import type { LocalIdentity } from './identity.js'
import type { Metadata } from './types.js'

export type Held = { to: string; since: number; why: string; sessionId: string }
type HeldFile = Record<string, Held>

const file = (dir: string) => path.join(dir, 'renames.json')

export const heldRenames = (dir: string): HeldFile => {
  try {
    return JSON.parse(fs.readFileSync(file(dir), 'utf-8')) as HeldFile
  } catch {
    return {}
  }
}

const writeHeld = (dir: string, h: HeldFile) => {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file(dir)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(h, null, 2))
  fs.renameSync(tmp, file(dir))
}

const owned = async (comms: Comms, member: string): Promise<string[]> => {
  const { reg } = await comms.state()
  const roles = [...(reg.members.get(member)?.roles ?? [])]
  return (await Promise.all(roles.map((r) => comms.claimsOf(member, r)))).flat()
}

export type RenamedPayload = { sessionId: string; from?: string; to: string; args: string[]; force: boolean; source: 'cli' | 'harness' }

export const followRename = async (
  dir: string,
  local: LocalIdentity,
  comms: Comms,
  p: RenamedPayload,
  meta: Metadata,
  now = Date.now(),
): Promise<{ lines: string[] }> => {
  const lines: string[] = []
  const bound = local.sessionMember(p.sessionId)
  const member = bound && local.member(bound) ? bound : p.from && local.member(p.from) ? p.from : undefined
  let current = member

  if (member && member !== p.to) {
    const claims = await owned(comms, member)
    if (claims.length && !p.force) {
      const why = `${member} owns claimed work (${claims.join(', ')})`
      writeHeld(dir, { ...heldRenames(dir), [member]: { to: p.to, since: now, why, sessionId: p.sessionId } })
      lines.push(
        `member ${member} keeps its name while it owns claimed work (${claims.join(', ')}); ` +
          `it becomes ${p.to} by itself once they are released, or now with /cortex-rename ${p.to} --force`,
      )
    } else {
      const r = await comms.rename(member, p.to, { force: p.force, meta })
      local.bindSession(p.sessionId, p.to)
      const held = heldRenames(dir)
      if (held[member]) {
        delete held[member]
        writeHeld(dir, held)
      }
      current = p.to
      lines.push(`renamed member ${member} to ${p.to}${r.roles.length ? ` in ${r.roles.join(', ')}` : ''}`)
    }
  }

  const role = p.args[0]
  if (role) {
    const existed = (await comms.roles()).some((r) => r.role === role)
    const joined = await comms.join(role, { as: current ?? p.to, create: true, meta })
    local.bindSession(p.sessionId, joined)
    lines.push(existed ? `joined role ${role} as ${joined}` : `created role ${role} (it did not exist) and joined as ${joined}`)
    // Joining mid-session must say how to listen in the same turn, as cortex-role join does.
    if (watchStatus(dir, joined).kind !== 'live') lines.push(`Do this now: ${watchInstruction(cliPath())}`)
  }
  return { lines }
}

/**
 * Complete a held rename whose claims are released. Called at the member's
 * hooks; returns the line to say once, or undefined.
 */
export const completeHeld = async (dir: string, local: LocalIdentity, comms: Comms, member: string, meta: Metadata): Promise<string | undefined> => {
  const held = heldRenames(dir)[member]
  if (!held || (await owned(comms, member)).length) return undefined
  const r = await comms.rename(member, held.to, { meta })
  local.bindSession(held.sessionId, held.to)
  const rest = heldRenames(dir)
  delete rest[member]
  writeHeld(dir, rest)
  return `Cortex comms: member ${member} is now ${held.to}${r.roles.length ? ` in ${r.roles.join(', ')}` : ''}; its claimed work is released, so the held rename is done.`
}
