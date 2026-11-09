import { assertName, matchesSelector, parseAddress } from './address.js'
import { ownership, stillOwner, type Ownership } from './claims.js'
import { directory } from './directory.js'
import { suggestNode, type NodeCandidate } from './suggest.js'
import { byPostedOrder } from './envelope.js'
import type { LocalIdentity } from './identity.js'
import { foldRegistry, lastBeats, liveMembers, liveRole, metaOf, nextMemberName } from './registry.js'
import { ADDR, type Transport } from './transport.js'
import type { Envelope, Metadata, Posted, Registry, RoleState } from './types.js'
import type { AnnouncedRole } from './mesh/nodes.js'
import { findNode, type ExternalDomain, type MeshView } from './mesh/view.js'
import os from 'node:os'

export type CommsOptions = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** A member is live if it beat within this window. */
  liveMs?: number
  /** How long a claim waits for competing claims when the role has other live members. */
  settleMs?: number
  /** The mesh as this node sees it, for node-qualified and remote addresses. Absent: this node only. */
  mesh?: () => MeshView
}

/**
 * Said to the sender when nobody at the address is listening, so a message
 * that will wait is never mistaken for one that was seen (19 Oct: a lapsed
 * watcher left the PM's messages queued overnight with no word). The node's
 * announcement carries each member's liveness: a beat within its live window.
 */
export const notListening = (roles: AnnouncedRole[], addr: { kind: 'role' | 'member'; role: string; member?: string }): string => {
  if (addr.kind === 'member') {
    const m = roles.flatMap((r) => r.members).find((x) => x.name === addr.member)
    return m && !m.live ? `; ${addr.member} is not listening now, so it waits until ${addr.member} is back` : ''
  }
  const role = roles.find((r) => r.role === addr.role)
  if (role) return role.members.some((m) => m.live) ? '' : `; no member of ${addr.role} is listening now, so it waits until one is back`
  const asMember = roles.flatMap((r) => r.members).find((x) => x.name === addr.role)
  return asMember && !asMember.live ? `; ${addr.role} is not listening now, so it waits until ${addr.role} is back` : ''
}

export const DEFAULT_LIVE_MS = Number(process.env.CKN_COMMS_LIVE_MS ?? 15 * 60_000)
export const DEFAULT_SETTLE_MS = Number(process.env.CKN_COMMS_SETTLE_MS ?? 3_000)

export type SendResult =
  | { ok: true; id: string; outcome: string }
  | { ok: false; outcome: string }

export type InboxItem = {
  id: string
  from: string
  to: string
  body: string
  stamp: number
  notify: boolean
  /** Work messages only: who holds it, if anyone. */
  ownership?: Ownership
  /** Where it arrived: a role mailbox, or this member's own. */
  via: string
  /** Set when it came from another node: that node's alias, or its id. */
  node?: string
  /** Files that came with it, where they are on this node. */
  files?: Envelope['files']
  awaits?: Envelope['awaits']
  /** From an external domain, through the gateway: data, never claimable. */
  foreign?: { domain: string; kind: string }
}

const memberOf = (from: string) => (from.includes('/') ? from.split('/')[1]! : from)

/**
 * The role epoch a message belongs to. A routed message carries none (the
 * sender cannot know the destination's epoch), so it belongs to the epoch
 * that is current when it is read.
 */
const epochOf = (p: Posted, r: RoleState): number | undefined => p.epoch ?? (p.remote ? r.epoch : undefined)

/**
 * The comms service: roles, members, delivery and claims, over any transport.
 *
 * Holds no state of its own. Every call re-reads the replicated log and folds
 * it, which is what lets two machines agree without talking to each other: they
 * fold the same log the same way.
 */
export class Comms {
  private now: () => number
  private sleep: (ms: number) => Promise<void>
  readonly liveMs: number
  readonly settleMs: number
  private mesh?: () => MeshView

  constructor(
    private transport: Transport,
    private local: LocalIdentity,
    opts: CommsOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.liveMs = opts.liveMs ?? DEFAULT_LIVE_MS
    this.settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS
    this.mesh = opts.mesh
  }

  /** A node's alias if it has one, else its id. */
  private label(view: MeshView | undefined, node: string): string {
    return view?.nodes.find((n) => n.node === node)?.alias ?? node
  }

  // ── reading ───────────────────────────────────────────────────────────────

  async state(): Promise<{ reg: Registry; beats: Map<string, number> }> {
    const [events, beats] = await Promise.all([
      this.transport.read(ADDR.registry),
      this.transport.read(ADDR.beat),
    ])
    return { reg: foldRegistry(events), beats: lastBeats(beats) }
  }

  private stampOf(): number {
    return this.now()
  }

  private async emit(event: Envelope['event'], from: string): Promise<string> {
    return this.transport.post(ADDR.registry, { v: 1, type: 'event', stamp: this.stampOf(), from, event })
  }

  /** `role/member` for a sender, preferring the role the message is going to. */
  fromOf(reg: Registry, member: string, preferRole?: string): string {
    const roles = [...(reg.members.get(member)?.roles ?? [])].sort()
    const role = preferRole && roles.includes(preferRole) ? preferRole : roles[0]
    return role ? `${role}/${member}` : member
  }

  // ── roles ────────────────────────────────────────────────────────────────

  async createRole(role: string, by: string): Promise<void> {
    assertName(role, 'role')
    await this.emit({ op: 'create', role }, by)
  }

  /**
   * Delete a role. Its unclaimed work goes back to the senders as a notice in
   * their own mailboxes, never silently dropped. Returns how many were returned.
   */
  async deleteRole(role: string, by: string): Promise<number> {
    const { reg } = await this.state()
    const r = liveRole(reg, role)
    if (!r) throw new Error(`no such role: ${role}`)
    const posted = await this.transport.read(ADDR.role(role))
    const pending = posted.filter(
      (p) => p.type === 'msg' && epochOf(p, r) === r.epoch && !p.notify && ownership(p.id, posted).state === 'unclaimed',
    )
    await this.emit({ op: 'delete', role }, by)
    for (const p of pending) {
      const sender = memberOf(p.from)
      await this.transport.post(ADDR.member(sender), {
        v: 1,
        type: 'msg',
        stamp: this.stampOf(),
        from: by,
        to: sender,
        ref: p.id,
        body: `role ${role} was deleted before your message ${p.id} was handled: ${(p.body ?? '').slice(0, 120)}`,
      })
    }
    return pending.length
  }

  // ── membership ───────────────────────────────────────────────────────────

  /**
   * Join a role, minting a member name unless one is given.
   *
   * Joining an unknown role fails unless `create`, so a typo can never create a
   * mailbox. A name already held by a DIFFERENT instance is refused rather than
   * shared.
   */
  async join(
    role: string,
    opts: { as?: string; create?: boolean; meta?: Metadata } = {},
  ): Promise<string> {
    assertName(role, 'role')
    let { reg } = await this.state()
    if (!liveRole(reg, role)) {
      if (!opts.create) throw new Error(`no such role: ${role} (use --create to make it)`)
      await this.createRole(role, opts.as ?? role)
      reg = (await this.state()).reg
    }
    const name = opts.as ?? nextMemberName(reg, role)
    assertName(name, 'member')
    const held = reg.members.get(name)
    const mine = this.local.member(name)
    if (held && mine && held.instance !== mine.instance) {
      throw new Error(`member name ${name} is held by another session; choose another with --as`)
    }
    if (held && !mine) {
      throw new Error(`member name ${name} belongs to a session on another machine; choose another with --as`)
    }
    const local = this.local.saveMember(name, held?.instance)
    await this.emit({ op: 'join', role, member: name, instance: local.instance, meta: opts.meta ?? {} }, `${role}/${name}`)
    await this.beat(name)
    return name
  }

  async leave(role: string, member: string): Promise<void> {
    await this.emit({ op: 'leave', role, member }, `${role}/${member}`)
  }

  /** Work in `role` this member owns (claimed or started). */
  async claimsOf(member: string, role: string): Promise<string[]> {
    return (await this.manifest(role))?.members.find((m) => m.name === member)?.claims ?? []
  }

  /** The roles a member holds here; undefined for a member the registry no longer knows (never "no roles"). */
  async rolesOf(member: string): Promise<string[] | undefined> {
    const { reg } = await this.state()
    const m = reg.members.get(member)
    return m ? [...m.roles].sort() : undefined
  }

  /**
   * The bus message a member is working on: its latest open claim in any role,
   * if any. Capture records it beside what the member writes, so a decision
   * relayed by message can be traced back to the message (private mind, D14).
   */
  async workContext(member: string): Promise<{ msgId: string; role: string } | undefined> {
    const { reg } = await this.state()
    let latest: { msgId: string; role: string } | undefined
    for (const role of [...(reg.members.get(member)?.roles ?? [])].sort()) {
      const claims = await this.claimsOf(member, role)
      if (claims.length) latest = { msgId: claims.at(-1)!, role }
    }
    return latest
  }

  /**
   * Move a member from one role to another, keeping its name.
   *
   * What happens to the old role, decided here rather than left implicit:
   *   - messages addressed to the ROLE stay with the role. They are its queue,
   *     not this member's, and the remaining or next member gets them;
   *   - work this member claimed there stays owned by its name. The move reports
   *     it rather than refusing, because claims have no done state to wait for;
   *   - a role this move leaves with no members is DELETED (2026-10-13):
   *     an explicit removal of the last member is the explicit end. Deletion
   *     returns its unhandled work to the senders, as any delete does. A session
   *     merely closing never gets here; offline members are still members.
   *     `keep` opts out.
   */
  async move(
    member: string,
    from: string,
    to: string,
    opts: { create?: boolean; meta?: Metadata; keep?: boolean } = {},
  ): Promise<{ claimsLeft: string[]; deleted: boolean; returned: number }> {
    const { reg } = await this.state()
    if (!reg.members.get(member)?.roles.has(from)) throw new Error(`${member} is not in role ${from}`)
    const claimsLeft = await this.claimsOf(member, from)
    await this.join(to, { as: member, create: opts.create, meta: opts.meta })
    const end = await this.leaveRole(from, member, { keep: opts.keep })
    return { claimsLeft, ...end }
  }

  /**
   * Remove a member from a role; delete the role if that left it empty, unless
   * `keep`. The explicit removal of the last member is the role's explicit end.
   */
  async leaveRole(role: string, member: string, opts: { keep?: boolean } = {}): Promise<{ deleted: boolean; returned: number }> {
    await this.leave(role, member)
    // A member left with no role is gone from the bus; keep no local record of it either.
    if (!(await this.state()).reg.members.get(member)?.roles.size) this.local.forgetMember(member)
    const after = await this.manifest(role)
    if (!after || after.members.length || opts.keep) return { deleted: false, returned: 0 }
    return { deleted: true, returned: await this.deleteRole(role, member) }
  }

  /**
   * Give a member a new name in the same roles. The old name leaves them.
   *
   * Refused while the old name owns claimed work unless forced: ownership is by
   * name, so the work would belong to a name nobody holds any more.
   */
  async rename(member: string, to: string, opts: { force?: boolean; meta?: Metadata } = {}): Promise<{ roles: string[] }> {
    assertName(to, 'member')
    const { reg } = await this.state()
    const roles = [...(reg.members.get(member)?.roles ?? [])].sort()
    const owned = (await Promise.all(roles.map((r) => this.claimsOf(member, r)))).flat()
    if (owned.length && !opts.force) {
      throw new Error(
        `${member} owns claimed work (${owned.join(', ')}); a rename would leave it with a name nobody holds. ` +
          'Finish or hand it over first, or pass --force',
      )
    }
    for (const r of roles) await this.join(r, { as: to, meta: opts.meta })
    for (const r of roles) await this.leave(r, member)
    this.local.forgetMember(member)
    return { roles }
  }

  async set(member: string, meta: Metadata): Promise<void> {
    await this.emit({ op: 'set', member, meta }, member)
  }

  async beat(member: string): Promise<void> {
    await this.transport.post(ADDR.beat, { v: 1, type: 'beat', stamp: this.stampOf(), from: member }, { ephemeral: true })
  }

  // ── sending ──────────────────────────────────────────────────────────────

  /**
   * Send a message, optionally with files and folders (`files`: paths here).
   * Files go wherever the message goes: into this node's inbox, or snapshotted
   * and routed to another node's, where they land in that mailbox's inbox.
   */
  async send(
    from: string,
    to: string,
    body: string,
    opts: { notify?: boolean; queueAnyway?: boolean; files?: string[]; silent?: boolean; awaits?: Envelope['awaits']; homeOnly?: boolean } = {},
  ): Promise<SendResult> {
    let addr = parseAddress(to)
    const { reg, beats } = await this.state()
    const view = this.mesh?.()

    // Which node? Named: that one. Unnamed: wherever the role (or member) is,
    // and if it is on more than one node, ask rather than guess.
    if (addr.node) {
      if (!view) return { ok: false, outcome: `this machine is not on the mesh, so "${addr.node}:" cannot be reached` }
      let n: ReturnType<typeof findNode>
      try {
        n = findNode(view, addr.node)
      } catch (err) {
        return { ok: false, outcome: (err as Error).message }
      }
      if (!n) {
        const ext = view.external?.find((e) => e.domain === addr.node)
        if (ext && opts.homeOnly) return { ok: false, outcome: `${addr.node} is an external domain, reached only through a gateway; a home-only message never is` }
        if (ext) return this.sendExternal(reg, ext, addr, from, body, opts)
        return { ok: false, outcome: `no such node: ${addr.node}` }
      }
      if (!n.self) return this.sendRemote(reg, view, n.node, addr, from, to, body, opts)
      const { node: _local, ...rest } = addr
      addr = rest as typeof addr
    } else if (view) {
      const name = addr.kind === 'member' ? addr.member : addr.role
      // A bare name may also be a member (see below), on this node or another.
      const bare = addr.kind === 'role' && !addr.selector && !addr.forced
      const holds = (roles: AnnouncedRole[]) =>
        addr.kind === 'member'
          ? roles.some((r) => r.members.some((m) => m.name === name))
          : roles.some((r) => r.role === name) || (bare && roles.some((r) => r.members.some((m) => m.name === name)))
      // An unreachable node's roles are not used (when a node goes offline, others
      // "cannot route or use roles or members from" it); naming the node still queues.
      const holders = view.nodes.filter((n) => holds(n.roles))
      const remote = holders.filter((n) => n.reachable)
      const here = addr.kind === 'member' ? reg.members.has(addr.member) : !!liveRole(reg, addr.role) || (bare && reg.members.has(addr.role))
      if (!here && !remote.length && holders.length) {
        // D1 (18 Oct 2026): with --queue-anyway, a name that only one node carries resolves to it
        // from that node's last announcement, and the message waits there until it is back.
        if (opts.queueAnyway && holders.length === 1) return this.sendRemote(reg, view, holders[0]!.node, addr, from, to, body, opts)
        const away = holders.map((n) => `${n.alias ?? n.node}:${name}`).join(', ')
        return {
          ok: false,
          outcome:
            `"${name}" is only on ${away}, unreachable now. Send to ${holders.length === 1 ? away : 'one of them'} by name` +
            `${holders.length === 1 ? ', or with --queue-anyway,' : ''} to queue it until it is back`,
        }
      }
      const places = [...(here ? [view.self.alias ?? view.self.node] : []), ...remote.map((n) => n.alias ?? n.node)]
      if (places.length > 1) {
        const ask = `"${name}" is on ${places.length} nodes: ${places.map((p) => `${p}:${name}`).join(', ')}. Which node?`
        const s = suggestNode(body, await this.candidates(reg, view, name, here, remote))
        return {
          ok: false,
          outcome: s ? `${ask} I suggest ${s.address}, since ${s.reason}. Send to ${s.address} to go ahead.` : `${ask} Send to node:${name}`,
        }
      }
      if (!here && remote.length === 1) return this.sendRemote(reg, view, remote[0]!.node, addr, from, to, body, opts)
    }
    // A bare name may be a member: "say hi to laptop-1" should just work.
    // It resolves when no role has that name; when both exist, refuse and name
    // the two explicit forms rather than guess.
    if (addr.kind === 'role' && !addr.selector && !addr.forced) {
      const asMember = [...(reg.members.get(addr.role)?.roles ?? [])].sort()
      if (asMember.length && liveRole(reg, addr.role)) {
        return { ok: false, outcome: `"${addr.role}" is both a role and a member: send to "role:${addr.role}" for the role, or "${asMember[0]}/${addr.role}" for the member` }
      }
      if (asMember.length) {
        addr = { kind: 'member', role: asMember[0]!, member: addr.role }
        to = `${asMember[0]}/${addr.member}`
      }
    }
    const role = liveRole(reg, addr.role)
    if (!role) return { ok: false, outcome: `no such role: ${addr.role}` }
    const fromStr = this.fromOf(reg, from, addr.role)
    const now = this.now()
    const live = liveMembers(reg, addr.role, beats, now, this.liveMs).filter((m) => m !== from)

    if (addr.kind === 'member') {
      if (!role.members.has(addr.member)) return { ok: false, outcome: `no such member: ${to}` }
      let files: Envelope['files']
      try {
        files = await this.saveLocal(ADDR.member(addr.member), opts.files)
      } catch (err) {
        return { ok: false, outcome: (err as Error).message }
      }
      const id = await this.transport.post(ADDR.member(addr.member), {
        v: 1, type: 'msg', stamp: this.stampOf(), from: fromStr, to, body, ...(files ? { files } : {}), ...(opts.silent ? { silent: true } : {}),
        ...(opts.awaits ? { awaits: opts.awaits } : {}),
      })
      return {
        ok: true,
        id,
        outcome: live.includes(addr.member) ? `delivered to ${to}` : `queued for ${to} (member offline)`,
      }
    }

    if (addr.selector) {
      const matching = [...role.members].filter((m) => matchesSelector(metaOf(reg, m), addr.selector))
      if (!matching.length && !opts.queueAnyway) {
        return { ok: false, outcome: `no member matches ${to} (use --queue-anyway to wait for one)` }
      }
    }

    let files: Envelope['files']
    try {
      files = await this.saveLocal(ADDR.role(addr.role), opts.files)
    } catch (err) {
      return { ok: false, outcome: (err as Error).message }
    }
    const id = await this.transport.post(ADDR.role(addr.role), {
      v: 1,
      type: 'msg',
      stamp: this.stampOf(),
      from: fromStr,
      to,
      epoch: role.epoch,
      ...(files ? { files } : {}),
      ...(opts.notify ? { notify: true } : {}),
      ...(opts.silent ? { silent: true } : {}),
      ...(opts.awaits ? { awaits: opts.awaits } : {}),
      ...(addr.selector ? { selector: addr.selector } : {}),
      body,
    })
    const n = live.length
    return {
      ok: true,
      id,
      outcome: n
        ? `delivered to role ${addr.role} (${n} live member${n === 1 ? '' : 's'})`
        : `queued for role ${addr.role} (no live members)`,
    }
  }

  private async saveLocal(address: string, sources?: string[]): Promise<Envelope['files']> {
    if (!sources?.length) return undefined
    if (!this.transport.saveFiles) throw new Error('this transport cannot carry files')
    return this.transport.saveFiles(address, sources)
  }

  /** Find a message by id across the mailboxes `member` can see. */
  async find(member: string, msgId: string): Promise<{ msg: Posted; mailbox: Posted[]; role?: string } | undefined> {
    const { reg } = await this.state()
    for (const role of reg.members.get(member)?.roles ?? []) {
      const mailbox = await this.transport.read(ADDR.role(role))
      const msg = mailbox.find((p) => p.id === msgId && p.type === 'msg')
      if (msg) return { msg, mailbox, role }
    }
    const own = await this.transport.read(ADDR.member(member))
    const msg = own.find((p) => p.id === msgId)
    return msg ? { msg, mailbox: own } : undefined
  }

  /**
   * Reply to a message: to its sender's member mailbox, carrying `ref`. If the
   * sender is no longer a known member, the reply goes to the sender's role so
   * any member there can pick it up by its ref.
   */
  async reply(from: string, msgId: string, body: string): Promise<SendResult> {
    const found = await this.find(from, msgId)
    if (!found) return { ok: false, outcome: `no message ${msgId} visible to ${from}` }
    const { reg } = await this.state()
    const target = found.msg.from
    const targetMember = memberOf(target)
    const targetRole = target.includes('/') ? target.split('/')[0]! : undefined
    if (found.msg.foreign) {
      const f = found.msg.foreign
      const ext = this.mesh?.()?.external?.find((e) => e.domain === f.domain)
      if (!ext) return { ok: false, outcome: `no gateway here serves ${f.domain} now` }
      return this.sendExternal(reg, ext, { kind: 'role', role: f.role }, from, body, {}, f.xid)
    }
    const env: Envelope = { v: 1, type: 'msg', stamp: this.stampOf(), from: this.fromOf(reg, from, targetRole), to: target, ref: msgId, body }
    if (found.msg.remote) {
      if (!this.transport.postTo) return { ok: false, outcome: 'this transport cannot reach other nodes' }
      const label = this.label(this.mesh?.(), found.msg.remote.node)
      const id = await this.transport.postTo(found.msg.remote.node, ADDR.member(targetMember), { ...env, ref: found.msg.remote.id })
      return { ok: true, id, outcome: `replied to ${label}:${target} (routed; held here until it is read)` }
    }
    if (reg.members.has(targetMember)) {
      const id = await this.transport.post(ADDR.member(targetMember), env)
      return { ok: true, id, outcome: `replied to ${target}` }
    }
    if (targetRole && liveRole(reg, targetRole)) {
      const id = await this.transport.post(ADDR.role(targetRole), { ...env, to: targetRole, epoch: liveRole(reg, targetRole)!.epoch })
      return { ok: true, id, outcome: `${targetMember} is gone; replied to role ${targetRole}` }
    }
    return { ok: false, outcome: `${target} no longer exists` }
  }

  // ── receiving ────────────────────────────────────────────────────────────

  /**
   * Messages for `member` it has not been shown yet: its own mailbox, plus work
   * and notify messages in every role it holds (current epoch, selector match,
   * never its own sends). Oldest first.
   */
  async inbox(member: string, opts: { includeSeen?: boolean; silent?: boolean } = {}): Promise<InboxItem[]> {
    // People and programs read apart: by default no silent message (a command's result) is
    // returned, so a watcher or a prompt never shows it or marks it seen; { silent: true } returns only those.
    const wanted = (p: { silent?: boolean }) => !!p.silent === !!opts.silent
    const { reg } = await this.state()
    const view = this.mesh?.()
    const seen = opts.includeSeen ? new Set<string>() : this.local.seen(member)
    const meta = metaOf(reg, member)
    const items: InboxItem[] = []

    for (const role of reg.members.get(member)?.roles ?? []) {
      const r = liveRole(reg, role)
      if (!r) continue
      const mailbox = await this.transport.read(ADDR.role(role))
      for (const p of mailbox) {
        if (p.type !== 'msg' || epochOf(p, r) !== r.epoch || seen.has(p.id) || !wanted(p)) continue
        if (memberOf(p.from) === member) continue
        if (!matchesSelector(meta, p.selector)) continue
        items.push({
          id: p.id, from: this.fromLabel(view, p), to: p.to ?? role, body: p.body ?? '', stamp: p.stamp,
          notify: !!p.notify, via: role,
          ...(p.notify ? {} : { ownership: ownership(p.id, mailbox) }),
          ...(p.remote ? { node: this.label(view, p.remote.node) } : {}),
          ...(p.files?.length ? { files: p.files } : {}),
          ...(p.awaits ? { awaits: p.awaits } : {}),
          ...(p.foreign ? { foreign: { domain: p.foreign.domain, kind: p.foreign.kind } } : {}),
        })
      }
    }
    for (const p of await this.transport.read(ADDR.member(member))) {
      if (p.type !== 'msg' || seen.has(p.id) || !wanted(p)) continue
      items.push({
        id: p.id, from: this.fromLabel(view, p), to: p.to ?? member, body: p.body ?? '', stamp: p.stamp, notify: false, via: member,
        ...(p.remote ? { node: this.label(view, p.remote.node) } : {}),
        ...(p.files?.length ? { files: p.files } : {}),
        ...(p.awaits ? { awaits: p.awaits } : {}),
        ...(p.foreign ? { foreign: { domain: p.foreign.domain, kind: p.foreign.kind } } : {}),
      })
    }
    return items.sort((a, b) => a.stamp - b.stamp || (a.id < b.id ? -1 : 1))
  }

  /** Shown to the session: remembered here, and acknowledged READ to the origin of anything routed. */
  markSeen(member: string, ids: string[]): void {
    this.local.markSeen(member, ids)
    void this.transport.shown?.(ids)
  }

  /** `node:role/member` for a routed message, so a reader sees where it came from. */
  private fromLabel(view: MeshView | undefined, p: Posted): string {
    if (p.foreign) return `${p.foreign.domain}:${p.foreign.role}/${p.foreign.human}`
    return p.remote ? `${this.label(view, p.remote.node)}:${p.from}` : p.from
  }

  /** The evidence for each node that has `name`: its members' capabilities and focus, and what it was asked before. */
  private async candidates(reg: Registry, view: MeshView, name: string, here: boolean, remote: MeshView['nodes']): Promise<NodeCandidate[]> {
    const out: NodeCandidate[] = []
    if (here) {
      const r = liveRole(reg, name)
      const members = r ? [...r.members] : [name]
      const about = members.flatMap((m) => [metaOf(reg, m).cap, metaOf(reg, m).focus].filter((x): x is string => !!x))
      const prior = r
        ? (await this.transport.read(ADDR.role(name))).filter((p) => p.type === 'msg' && p.body).sort((a, b) => b.stamp - a.stamp).slice(0, 100).map((p) => p.body!)
        : []
      out.push({ address: `${view.self.alias ?? view.self.node}:${name}`, about, prior })
    }
    for (const n of remote) {
      const roles = n.roles.filter((r) => r.role === name || r.members.some((m) => m.name === name))
      const about = roles.flatMap((r) => r.members.flatMap((m) => [m.capabilities, m.focus].filter((x): x is string => !!x)))
      const prior = view.history
        .filter((h) => h.node === n.node && (h.address === ADDR.role(name) || h.address === ADDR.member(name)))
        .map((h) => h.subject)
      out.push({ address: `${n.alias ?? n.node}:${name}`, about, prior })
    }
    return out
  }

  /**
   * Send to a role in an external domain: routed to the gateway that serves it,
   * which checks, sanitizes, signs and sends it on. Held here until it is read there.
   */
  private async sendExternal(
    reg: Registry,
    ext: ExternalDomain,
    addr: { kind: string; role: string; selector?: unknown; forced?: boolean },
    from: string,
    body: string,
    opts: { files?: string[] },
    ref?: string,
  ): Promise<SendResult> {
    if (!this.transport.postTo) return { ok: false, outcome: 'this transport cannot reach other nodes' }
    if (addr.kind !== 'role' || addr.selector || addr.forced) return { ok: false, outcome: `an external domain is addressed by role only: ${ext.domain}:<role>` }
    if (opts.files?.length && !this.transport.postFilesTo) return { ok: false, outcome: 'this transport cannot carry files' }
    const to = `${ext.domain}:${addr.role}`
    const env: Envelope = { v: 1, type: 'msg', stamp: this.stampOf(), from: this.fromOf(reg, from), to, human: os.userInfo().username, ...(ref ? { ref } : {}), body }
    const mailbox = `gate:${ext.domain}:${addr.role}`
    let id: string
    try {
      id = opts.files?.length ? await this.transport.postFilesTo!(ext.gateway, mailbox, env, opts.files) : await this.transport.postTo(ext.gateway, mailbox, env)
    } catch (err) {
      return { ok: false, outcome: (err as Error).message }
    }
    const notes = [
      ...(ext.reachable ? [] : ['the gateway is unreachable now, so it waits here']),
      ...(ext.linked ? [] : [`${ext.domain} is not linked now, so it waits at the gateway`]),
      ...(ext.unavailable.includes(addr.role) ? [`${ext.domain} says ${addr.role} is unavailable now`] : []),
    ]
    return { ok: true, id, outcome: `sent to ${to} through the gateway${notes.length ? ` (${notes.join('; ')})` : ''}; held here until it is read there` }
  }

  /** What this node knows of the mesh, external domains included; undefined off the mesh. */
  meshView(): MeshView | undefined {
    return this.mesh?.()
  }

  /** Close the return path from an external role to this member's role: its replies are refused from now on. */
  async closeReturn(from: string, target: string): Promise<SendResult> {
    const addr = parseAddress(target)
    const ext = addr.node ? this.mesh?.()?.external?.find((e) => e.domain === addr.node) : undefined
    if (!ext || addr.kind !== 'role') return { ok: false, outcome: `close-return takes <domain>:<role> for a domain a gateway here serves (got ${target})` }
    if (!this.transport.postTo) return { ok: false, outcome: 'this transport cannot reach other nodes' }
    const { reg } = await this.state()
    if (!reg.members.get(from)?.roles.size) return { ok: false, outcome: `${from} holds no role, so it has no return path to close` }
    const env: Envelope = { v: 1, type: 'msg', stamp: this.stampOf(), from: this.fromOf(reg, from), to: target, human: os.userInfo().username, body: 'close-return' }
    const id = await this.transport.postTo(ext.gateway, `gate-ctl:close:${ext.domain}:${addr.role}`, env)
    return { ok: true, id, outcome: `asked the gateway to close the return path from ${target} to ${env.from.split('/')[0]}` }
  }

  /** Send to a role or member on another node: routed there, held here until READ. */
  private async sendRemote(
    reg: Registry,
    view: MeshView,
    node: string,
    addr: ReturnType<typeof parseAddress>,
    from: string,
    to: string,
    body: string,
    opts: { notify?: boolean; files?: string[]; silent?: boolean; awaits?: Envelope['awaits']; homeOnly?: boolean },
  ): Promise<SendResult> {
    if (!this.transport.postTo) return { ok: false, outcome: 'this transport cannot reach other nodes' }
    if (opts.files?.length && !this.transport.postFilesTo) return { ok: false, outcome: 'this transport cannot carry files' }
    const target = view.nodes.find((n) => n.node === node)!
    const label = target.alias ?? node
    if (target.expired) {
      const since = target.offlineSince ? ` since ${new Date(target.offlineSince).toISOString().slice(0, 10)}` : ''
      return { ok: false, outcome: `node ${label} has been offline${since}, past its limit; it accepts no messages until it is back` }
    }
    // Home only: never through a gateway. Unreachable altogether, it waits for a home route like any message.
    if (opts.homeOnly && target.reachable && !target.homeReachable) {
      return { ok: false, outcome: `the only route to ${label} now goes through a gateway; a home-only message never does` }
    }
    let mailbox: string
    let shown: string
    if (addr.kind === 'member') {
      if (!target.roles.some((r) => r.members.some((m) => m.name === addr.member))) return { ok: false, outcome: `no member ${addr.member} on node ${label}` }
      mailbox = ADDR.member(addr.member)
      shown = `${label}:${addr.role}/${addr.member}`
    } else if (target.roles.some((r) => r.role === addr.role)) {
      mailbox = ADDR.role(addr.role)
      shown = `${label}:${addr.role}`
    } else {
      const holder = target.roles.find((r) => r.members.some((m) => m.name === addr.role))
      if (!holder || addr.selector || addr.forced) return { ok: false, outcome: `no role ${addr.role} on node ${label}` }
      mailbox = ADDR.member(addr.role) // a bare name that is a member there
      shown = `${label}:${holder.role}/${addr.role}`
    }
    const env: Envelope = {
      v: 1,
      type: 'msg',
      stamp: this.stampOf(),
      from: this.fromOf(reg, from),
      to,
      ...(opts.notify ? { notify: true } : {}),
      ...(opts.silent ? { silent: true } : {}),
      ...(opts.awaits ? { awaits: opts.awaits } : {}),
      ...(addr.kind === 'role' && addr.selector ? { selector: addr.selector } : {}),
      body,
    }
    let id: string
    try {
      const route = opts.homeOnly ? { home: true } : {}
      id = opts.files?.length ? await this.transport.postFilesTo!(node, mailbox, env, opts.files, route) : await this.transport.postTo(node, mailbox, env, route)
    } catch (err) {
      return { ok: false, outcome: (err as Error).message }
    }
    return {
      ok: true,
      id,
      outcome:
        (target.reachable
          ? `sent to ${shown} (routed; held here until it is read)`
          : `queued for ${shown} (node unreachable now; held here until it is back and the message is read)`) +
        (target.reachable ? notListening(target.roles, addr) : ''),
    }
  }

  // ── claims ───────────────────────────────────────────────────────────────

  /**
   * Claim a work message.
   *
   * On the mesh a role's members all live on its node and share one log, so
   * the transport decides in one transaction: first committed claim wins
   * (node:role:member). Elsewhere (the V1 bus), the posted-stamp rule:
   *
   *   - already started by someone else: refuse, rule (b)
   *   - the role has no OTHER live member: claim and start at once, no wait
   *   - otherwise: post the claim, wait the settle window, apply the rule
   *
   * The claim and `started` are both posted on the role mailbox, so every
   * member sees who took what.
   */
  async claim(member: string, msgId: string): Promise<{ won: boolean; owner: string; waited: boolean }> {
    const found = await this.find(member, msgId)
    if (!found?.role) throw new Error(`no work message ${msgId} in any role ${member} holds`)
    if (found.msg.notify) throw new Error(`${msgId} is a notify message; nobody claims those`)
    const before = ownership(msgId, found.mailbox)
    if (before.state === 'started' && before.owner !== member) {
      return { won: false, owner: before.owner, waited: false }
    }
    const { reg, beats } = await this.state()
    const from = this.fromOf(reg, member, found.role)
    if (this.transport.claimAtomic) {
      const stamp = this.stampOf()
      const r = await this.transport.claimAtomic(
        ADDR.role(found.role),
        msgId,
        { v: 1, type: 'claim', stamp, from, ref: msgId },
        { v: 1, type: 'started', stamp, from, ref: msgId },
      )
      return { won: r.won, owner: r.owner, waited: false }
    }
    const others = liveMembers(reg, found.role, beats, this.now(), this.liveMs).filter((m) => m !== member)

    await this.transport.post(ADDR.role(found.role), { v: 1, type: 'claim', stamp: this.stampOf(), from, ref: msgId })
    const waited = others.length > 0
    if (waited) await this.sleep(this.settleMs)

    const after = ownership(msgId, await this.transport.read(ADDR.role(found.role)))
    if (after.state === 'unclaimed' || after.owner !== member) {
      return { won: false, owner: after.state === 'unclaimed' ? '' : after.owner, waited }
    }
    if (after.state !== 'started') {
      await this.transport.post(ADDR.role(found.role), { v: 1, type: 'started', stamp: this.stampOf(), from, ref: msgId })
    }
    return { won: true, owner: member, waited }
  }

  /** Fencing check, for right before an irreversible step. */
  /**
   * Finish claimed work: it is no longer this member's claim. Claims had no
   * end before (19 Oct), so a rename held for claimed work could never
   * complete; `cortex-role done <id>` is that end.
   */
  async done(member: string, msgId: string): Promise<void> {
    const found = await this.find(member, msgId)
    if (!found?.role) throw new Error(`no work message ${msgId} in any role ${member} holds`)
    const o = ownership(msgId, found.mailbox)
    if (o.state === 'done') return
    if (o.state !== 'started' || o.owner !== member) throw new Error(`${msgId} is not ${member}'s started work (${o.state}${'owner' in o ? ` by ${o.owner}` : ''})`)
    const { reg } = await this.state()
    await this.transport.post(ADDR.role(found.role), { v: 1, type: 'done', stamp: this.stampOf(), from: this.fromOf(reg, member, found.role), ref: msgId })
  }

  async check(member: string, msgId: string): Promise<boolean> {
    const found = await this.find(member, msgId)
    if (!found?.role) return false
    return stillOwner(member, msgId, found.mailbox)
  }

  // ── views ────────────────────────────────────────────────────────────────

  async manifest(role: string) {
    const { reg, beats } = await this.state()
    const r = liveRole(reg, role)
    if (!r) return undefined
    const mailbox = await this.transport.read(ADDR.role(role))
    const now = this.now()
    const work = mailbox.filter((p) => p.type === 'msg' && epochOf(p, r) === r.epoch && !p.notify).sort(byPostedOrder)
    const unclaimed = work.filter((p) => ownership(p.id, mailbox).state === 'unclaimed')
    return {
      role,
      epoch: r.epoch,
      retention: 'none',
      queueDepth: unclaimed.length,
      oldestUnclaimed: unclaimed[0]?.id,
      members: [...r.members].sort().map((m) => ({
        name: m,
        live: now - (beats.get(m) ?? 0) <= this.liveMs,
        lastSeen: beats.get(m) ?? 0,
        meta: metaOf(reg, m),
        claims: work
          .filter((p) => {
            const o = ownership(p.id, mailbox)
            return (o.state === 'claimed' || o.state === 'started') && o.owner === m
          })
          .map((p) => p.id),
      })),
    }
  }

  /** Every member on every machine the bus reaches. */
  async directory() {
    const { reg, beats } = await this.state()
    return directory(reg, beats, this.now(), this.liveMs)
  }

  async roles() {
    const { reg, beats } = await this.state()
    const now = this.now()
    const out = []
    for (const r of [...reg.roles.values()].filter((x) => !x.deleted).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({
        role: r.name,
        members: r.members.size,
        live: liveMembers(reg, r.name, beats, now, this.liveMs).length,
      })
    }
    return out
  }
}

