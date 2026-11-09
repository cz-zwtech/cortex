#!/usr/bin/env tsx
/**
 * cortex-role: roles and role-addressed messages from a terminal or a session.
 *
 *   whoami                              my member name, roles, metadata, waiting count
 *   join <role> [--create] [--as <name>] [--meta k=v,k=v]
 *   leave <role>
 *   create <role> | delete <role>
 *   list | show <role>
 *   set k=v [k=v ...]                   declare my metadata (never a permission)
 *   send <to> <text...> [--notify] [--queue-anyway] [--body-file <path> | -] [--file <path>]...
 *                          --file sends a file or folder with the message (repeatable); it lands in the
 *                          receiving mailbox's inbox folder, on this node or another
 *   reply <msg-id> <text...> [--body-file <path> | -]
 *   close-return <domain>:<role>        an external role may no longer reply to my role (until I write to it again)
 *   inbox [--all]
 *   claim <msg-id> | check <msg-id> | done <msg-id>
 *   move <from> <to> [--create] [--keep] change role, keep the name; an emptied role is deleted unless --keep
 *   watch                               one line per new message, for a Monitor
 *   who [words...]                      no words: everyone on the bus; words: who should handle them
 *   who --mesh [--live] [--json]        every role on every node, with its address; --live: reachable with a live member
 *   debug [on|off]                      verbose output: delivery status, liveness, recipients, claims
 *
 * Normal output is the message and its sender. --verbose or CKN_COMMS_VERBOSE=1
 * turns on the detail for one command or one environment.
 *
 * WHO AM I. `--as <name>` wins. Otherwise the session this runs inside is
 * resolved through the adapter's id-to-name cache, using the
 * CLAUDE_CODE_SESSION_ID that Claude Code sets in Bash-tool subprocesses. That
 * cache is the only place a harness session id is used, and only to answer
 * "which member is running me".
 *
 * BODIES. `--body-file` or `-` (stdin) never pass through a shell, which is the
 * fix for V1's BUS-11: text with backticks or dollar signs arrives intact.
 */

import fs from 'node:fs'
import path from 'node:path'

import { dataRoot, meshDir } from '../core/paths.js'
import { machineId } from '../core/machineId.js'
import { MeshLog } from '../modules/comms/server/mesh/log.js'
import { meshView } from '../modules/comms/server/mesh/view.js'
import { localRoles } from '../modules/comms/server/meshBridge.js'
import { meshRoleLine, meshRoles } from '../modules/comms/server/meshWho.js'
import { metaFor, openComms } from '../modules/comms/server/session.js'
import type { Metadata } from '../modules/comms/server/types.js'
import { recordWatch, takeReminder, watchStatus, WATCH_BEAT_MS, type WatchState } from '../modules/comms/server/watchState.js'
import { watchInstruction } from '../modules/comms/server/hooks.js'
import { cliPath } from '../modules/comms/server/session.js'
import { isVerbose, setVerbose } from '../modules/comms/server/verbose.js'
import { messageLine } from '../modules/comms/server/session.js'
import { presence, resolve } from '../modules/comms/server/directory.js'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const bool = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return false
  args.splice(i, 1)
  return true
}
const die = (msg: string, code = 1): never => {
  console.error(`cortex-role: ${msg}`)
  process.exit(code)
}

const parseMeta = (pairs: string[]): Metadata => {
  const meta: Metadata = {}
  for (const pair of pairs.flatMap((p) => p.split(','))) {
    const eq = pair.indexOf('=')
    if (eq <= 0) die(`bad metadata "${pair}": expected key=value`)
    meta[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return meta
}

/** Every value of a repeatable flag. */
const flags = (name: string): string[] => {
  const out: string[] = []
  for (let v = flag(name); v !== undefined; v = flag(name)) out.push(v)
  return out
}

const files = flags('--file')
const asName = flag('--as')
const bodyFile = flag('--body-file')
const metaFlag = flag('--meta')
const notify = bool('--notify')
const verbose = bool('--verbose') || isVerbose(path.join(dataRoot(), 'comms'))
const queueAnyway = bool('--queue-anyway')
const create = bool('--create')
const all = bool('--all')
const keep = bool('--keep')
const force = bool('--force')
const mesh = bool('--mesh')
const liveOnly = bool('--live')
const json = bool('--json')
const [cmd = 'whoami', ...rest] = args

const { local, comms } = openComms(path.join(dataRoot(), 'comms'))
const sessionId = process.env.CLAUDE_CODE_SESSION_ID

const me = (): string => {
  const name = asName ?? local.sessionMember(sessionId)
  if (!name) die('this session is not a member of any role. Join one: cortex-role join <role> [--create]')
  return name!
}

const readBody = (from: string[]): string => {
  if (bodyFile === '-' || (from.length === 1 && from[0] === '-')) return fs.readFileSync(0, 'utf-8')
  if (bodyFile) return fs.readFileSync(bodyFile, 'utf-8')
  const text = from.join(' ').trim()
  if (!text) die('empty message body')
  return text
}

/**
 * What a sender needs back. Normally just the id; a queue with nobody live and
 * every failure are always shown, because they change what the sender does.
 */
/** What leaving did to the role: an emptied role is deleted unless --keep. */
const endNote = (role: string, r: { deleted: boolean; returned: number }): string =>
  r.deleted
    ? `; ${role} had no members left and was deleted${r.returned ? `, ${r.returned} unhandled message(s) returned to their senders` : ''}`
    : ''

/**
 * Joining mid-session (join, rename, move) must say how to listen in the same
 * turn: the next prompt usually brings a task, and a session acts on that first
 * (laptop step 6, session 2). Counts as that session's reminder.
 */
const armHint = (name: string) => {
  const dir = path.join(dataRoot(), 'comms')
  const st = watchStatus(dir, name)
  if (st.kind === 'live') return
  takeReminder(dir, name, sessionId, st)
  console.log(`Do this now: ${watchInstruction(cliPath())}`)
}

/** A role that does not exist is created by join, rename and move. Say which, so a typo shows. */
const roleExists = async (role: string) => (await comms.roles()).some((r) => r.role === role)
const joinedLine = (role: string, name: string, existed: boolean) =>
  existed ? `joined role ${role} as ${name}` : `created role ${role} (it did not exist) and joined as ${name}`

const sentLine = (r: { ok: true; id: string; outcome: string } | { ok: false; outcome: string }): string => {
  if (!r.ok) return r.outcome
  if (verbose) return `sent ${r.id}: ${r.outcome}`
  return /^queued|gone/.test(r.outcome) ? `sent ${r.id}: ${r.outcome}` : `sent ${r.id}`
}

const fmtTime = (t: number) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : 'never')

try {
  switch (cmd) {
    case 'whoami': {
      const name = asName ?? local.sessionMember(sessionId)
      if (!name) {
        console.log('This session is not a member of any role.')
        console.log('Join one with: cortex-role join <role>   (add --create for a new role)')
        break
      }
      const { reg } = await comms.state()
      const m = reg.members.get(name)
      const waiting = await comms.inbox(name)
      console.log(`member:  ${name}`)
      console.log(`roles:   ${[...(m?.roles ?? [])].sort().join(', ') || '(none)'}`)
      console.log(`meta:    ${Object.entries(m?.meta ?? {}).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`)
      console.log(`waiting: ${waiting.length} message(s)${waiting.length ? ' (cortex-role inbox)' : ''}`)
      // Return paths are the gateway's; it publishes them with each external domain it serves.
      const mine = new Set(m?.roles ?? [])
      const paths = (comms.meshView()?.external ?? []).flatMap((e) => e.paths.filter((p) => mine.has(p.role)).map((p) => ({ ...p, domain: e.domain })))
      if (paths.length) {
        console.log('return paths (an external role that may reply to your role; close with cortex-role close-return <domain>:<role>):')
        for (const p of paths) console.log(`  ${p.domain}:${p.from} -> ${p.role}`)
      }
      break
    }
    case 'join': {
      const role = rest[0] ?? die('usage: join <role> [--create] [--as <name>]')
      const existed = await roleExists(role)
      const name = await comms.join(role, {
        as: asName,
        create: true,
        meta: { ...metaFor({ cwd: process.cwd() }), ...(metaFlag ? parseMeta([metaFlag]) : {}) },
      })
      local.bindSession(sessionId, name)
      console.log(joinedLine(role, name, existed))
      if (sessionId) console.log(`this session's title becomes ${name} at your next prompt, so the name survives resume`)
      armHint(name)
      break
    }
    case 'leave': {
      const role = rest[0] ?? die('usage: leave <role> [--keep]')
      const r = await comms.leaveRole(role, me(), { keep })
      console.log(`left role ${role}${endNote(role, r)}`)
      break
    }
    case 'move': {
      const [from, to] = rest
      if (!from || !to) die('usage: move <from-role> <to-role> [--create] [--keep]')
      const name = me()
      const existed = await roleExists(to!)
      const r = await comms.move(name, from!, to!, { create: true, keep })
      console.log(`${name} moved from ${from} to ${to}${existed ? '' : ` (created role ${to}: it did not exist)`}${endNote(from!, r)}`)
      armHint(name)
      if (r.claimsLeft.length) {
        console.log(`you still own ${r.claimsLeft.length} item(s) claimed in ${from} (${r.claimsLeft.join(', ')}); they stay yours by name`)
      }
      break
    }
    case 'create': {
      const role = rest[0] ?? die('usage: create <role>')
      await comms.createRole(role, asName ?? local.sessionMember(sessionId) ?? 'cli')
      console.log(`role ${role} exists`)
      break
    }
    case 'delete': {
      const role = rest[0] ?? die('usage: delete <role>')
      const returned = await comms.deleteRole(role, asName ?? local.sessionMember(sessionId) ?? 'cli')
      console.log(`role ${role} deleted; ${returned} unhandled message(s) returned to their senders`)
      break
    }
    case 'list': {
      const roles = await comms.roles()
      if (!roles.length) console.log('(no roles)')
      for (const r of roles) console.log(`${r.role.padEnd(24)} ${r.live}/${r.members} live`)
      break
    }
    case 'show': {
      const role = rest[0] ?? die('usage: show <role>')
      const m = await comms.manifest(role)
      if (!m) die(`no such role: ${role}`)
      console.log(`role ${m!.role}  epoch ${m!.epoch}  retention ${m!.retention}  queue ${m!.queueDepth}${m!.oldestUnclaimed ? ` (oldest ${m!.oldestUnclaimed})` : ''}`)
      for (const x of m!.members) {
        const meta = Object.entries(x.meta).filter(([k]) => k !== 'cwd').map(([k, v]) => `${k}=${v}`).join(' ')
        console.log(`  ${presence(x).padEnd(7)} ${x.name.padEnd(20)} last seen ${fmtTime(x.lastSeen)}  ${meta}${x.claims.length ? `  claims ${x.claims.join(',')}` : ''}`)
      }
      break
    }
    case 'set': {
      if (!rest.length) die('usage: set key=value [key=value ...]')
      await comms.set(me(), parseMeta(rest))
      console.log('metadata updated (declared only; it never grants a permission)')
      break
    }
    case 'send': {
      const to = rest[0] ?? die('usage: send <to> <text...>')
      const r = await comms.send(me(), to, readBody(rest.slice(1)), { notify, queueAnyway, ...(files.length ? { files } : {}) })
      console.log(sentLine(r))
      if (!r.ok) process.exit(1)
      break
    }
    case 'reply': {
      const id = rest[0] ?? die('usage: reply <msg-id> <text...>')
      const r = await comms.reply(me(), id, readBody(rest.slice(1)))
      console.log(sentLine(r))
      if (!r.ok) process.exit(1)
      break
    }
    case 'close-return': {
      const target = rest[0] ?? die('usage: close-return <domain>:<role>')
      const r = await comms.closeReturn(me(), target)
      console.log(sentLine(r))
      if (!r.ok) process.exit(1)
      break
    }
    case 'inbox': {
      const name = me()
      const items = await comms.inbox(name, { includeSeen: all })
      if (!items.length) console.log('(no new messages)')
      for (const i of items) {
        if (!verbose) {
          const work = i.ownership?.state === 'unclaimed' ? ' [work: claim before acting]' : ''
          console.log(`${i.from}${work} (id ${i.id}):\n  ${i.body.replace(/\n/g, '\n  ')}`)
          continue
        }
        const tag = i.notify ? 'notify' : i.ownership ? (i.ownership.state === 'unclaimed' ? 'work, unclaimed' : `work, ${i.ownership.state} by ${i.ownership.owner}`) : 'direct'
        console.log(`[${i.id}] ${fmtTime(i.stamp)} ${i.from} -> ${i.to} (${tag})\n  ${i.body.replace(/\n/g, '\n  ')}`)
      }
      comms.markSeen(name, items.map((i) => i.id))
      break
    }
    case 'claim': {
      const id = rest[0] ?? die('usage: claim <msg-id>')
      const r = await comms.claim(me(), id)
      if (r.won) console.log(`WON ${id}: it is yours${r.waited ? '' : ' (only live member, no wait)'}. Run cortex-role check ${id} before any irreversible step.`)
      else console.log(`LOST ${id}: ${r.owner || 'nobody'} owns it. Stand down.`)
      if (!r.won) process.exit(3)
      break
    }
    case 'done': {
      const id = rest[0] ?? die('usage: done <msg-id>')
      await comms.done(me(), id!)
      console.log(`done ${id}: it is no longer your claim`)
      break
    }
    case 'check': {
      const id = rest[0] ?? die('usage: check <msg-id>')
      const ok = await comms.check(me(), id)
      console.log(ok ? `still yours: ${id}` : `NOT yours: ${id}. Stop before any irreversible step.`)
      if (!ok) process.exit(3)
      break
    }
    case 'who': {
      if (mesh) {
        // Every role on every node this one knows, from its announcements; --live: reachable, with a live member.
        if (!fs.existsSync(path.join(meshDir(), 'mesh.sqlite'))) die('no mesh on this machine: who --mesh needs the mesh module')
        const log = new MeshLog(meshDir(), machineId())
        const rows = meshRoles(meshView(meshDir(), machineId()), localRoles(log)(), { live: liveOnly })
        log.close()
        if (json) console.log(JSON.stringify(rows))
        else if (!rows.length) console.log(liveOnly ? '(no role on the mesh has a live member)' : '(no roles on the mesh)')
        else for (const r of rows) console.log(meshRoleLine(r))
        break
      }
      // No words: the directory. Words: who should handle them.
      const entries = await comms.directory()
      const ago = (t: number) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 60_000))}m ago` : 'never')
      if (!rest.length) {
        if (!entries.length) console.log('(no one on the bus yet)')
        for (const e of entries) {
          const about = e.meta.about ? `  ${e.meta.about}` : ''
          console.log(`${presence(e).padEnd(7)} ${e.member.padEnd(22)} ${e.roles.join(',').padEnd(18)} ${String(e.meta.machine ?? '').padEnd(18)} ${ago(e.lastSeen)}${about}`)
        }
        break
      }
      const { verdict, candidates } = resolve(rest.join(' '), entries)
      const line = (c: (typeof candidates)[number], i: number) =>
        `  ${i + 1}. ${c.address}  (${presence(c.entry)}${c.entry.meta.machine ? `, ${c.entry.meta.machine}` : ''})  ${c.reasons.join('; ')}`
      if (verdict === 'clear') {
        console.log(`clear: ${candidates[0]!.address}`)
        console.log(line(candidates[0]!, 0))
        console.log(`send with: /cortex-role send ${candidates[0]!.address} "<message>"   (or to the role ${candidates[0]!.entry.roles[0]} for any of its members)`)
      } else if (verdict === 'ask') {
        console.log('ask the user: no single clear owner. Show these and confirm before sending anything:')
        candidates.forEach((c, i) => console.log(line(c, i)))
      } else {
        console.log('no one on the bus matches. Ask the user who should handle it, or create a role for it.')
      }
      break
    }
    case 'debug': {
      const dir = path.join(dataRoot(), 'comms')
      const want = rest[0]
      if (want === 'on' || want === 'off') setVerbose(dir, want === 'on')
      console.log(`comms output: ${isVerbose(dir) ? 'verbose (delivery status, liveness, recipients, claim detail)' : 'normal'}`)
      break
    }
        case 'watch': {
      const name = me()
      const deadline = Date.now() + 29 * 60_000
      let lastBeat = 0
      // Liveness for the hooks, keyed by member: they remind only when this
      // has actually stopped, and know a lapse from never having started.
      const commsDir = path.join(dataRoot(), 'comms')
      const state: WatchState = { member: name, pid: process.pid, startedAt: Date.now(), beatAt: Date.now() }
      recordWatch(commsDir, state)
      const end = () => recordWatch(commsDir, { ...state, beatAt: Date.now(), endedAt: Date.now() })
      for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
        process.on(sig, () => {
          end()
          process.exit(0)
        })
      }
      let lastWatchBeat = Date.now()
      for (;;) {
        if (Date.now() - lastWatchBeat >= WATCH_BEAT_MS) {
          recordWatch(commsDir, { ...state, beatAt: Date.now() })
          lastWatchBeat = Date.now()
        }
        if (Date.now() - lastBeat > 60_000) {
          await comms.beat(name).catch(() => undefined)
          lastBeat = Date.now()
        }
        try {
          const items = await comms.inbox(name)
          for (const i of items) {
            console.log(
              verbose
                ? `[comms] (id ${i.id}) ${i.from} -> ${i.to}${i.notify ? ' [notify]' : ''}: ${i.body.replace(/\s+/g, ' ').slice(0, 400)}`
                : `[comms] ${messageLine(i).slice(2)}`,
            )
          }
          comms.markSeen(name, items.map((i) => i.id))
        } catch (err) {
          // The bus being down is not a reason to exit: wait and retry. Exiting
          // here is how a V1 session went deaf without noticing (BUS-08).
          console.error(`cortex-role watch: ${err instanceof Error ? err.message : String(err)}; retrying`)
        }
        if (Date.now() > deadline) {
          end()
          console.log('[comms] watch window ended; re-arm now: watchers stay on while paused or idle')
          break
        }
        await new Promise((r) => setTimeout(r, 3_000))
      }
      break
    }
    default:
      die(`unknown command "${cmd}". See the header of bin/cortex-role.ts`, 2)
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  die(msg)
}
