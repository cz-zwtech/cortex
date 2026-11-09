/**
 * Shared shapes for the comms module.
 *
 * Three separate things the V1 bus collapsed into one: a ROLE is a mailbox (what
 * a session is for), a MEMBER is a unique display name (who a session is), and a
 * harness session id is plumbing that never appears in any of these types. See
 * docs/cortex/2026-10-12-bus-role-mailboxes-design.md.
 */

export type Metadata = Record<string, string>

/** Kinds of envelope carried on the transport. */
export type EnvelopeType =
  | 'event' // registry change: create, delete, join, leave, set
  | 'msg' // a message to a role or a member
  | 'claim' // a member claims a work message (a reply on the role mailbox)
  | 'started' // the settled owner has begun; cannot be taken back
  | 'done' // the owner has finished: the work is no longer anyone's claim
  | 'beat' // liveness

export type RegistryEvent =
  | { op: 'create'; role: string }
  | { op: 'delete'; role: string }
  | { op: 'join'; role: string; member: string; instance: string; meta: Metadata }
  | { op: 'leave'; role: string; member: string }
  | { op: 'set'; member: string; meta: Metadata }

export type Envelope = {
  v: 1
  type: EnvelopeType
  /**
   * The sender's own wall-clock time, as posted. Every node compares the posted
   * value, so every node orders the same way whatever the clocks say. The
   * rule; see the claims section of the design.
   */
  stamp: number
  /** `role/member`, or a bare member when the sender holds no role. */
  from: string
  /** Target as written: `role`, `role/member`, `role[k=v]`. Absent for events and beats. */
  to?: string
  /** Role epoch the message was sent into. A message never leaks into a re-created role. */
  epoch?: number
  notify?: boolean
  /**
   * For a program, not a person: a command's result. Never shown by the
   * watcher or at a prompt, and never marked seen by them; the program reads
   * it with inbox(member, { silent: true }).
   */
  silent?: boolean
  selector?: Metadata
  body?: string
  /** The message a claim, started or reply refers to. */
  ref?: string
  event?: RegistryEvent
  /** Files sent with the message: where they landed on the receiving node once delivered. */
  files?: { name: string; path?: string; size: number; sha256: string }[]
  /**
   * The sender expects an answer elsewhere (an operator on Telegram). Once the
   * member has seen it, Stop reminds it once while `key` is not marked answered.
   */
  awaits?: { key: string; how: string }
  /** The OS user of the sending session, on records bound for a gateway: trusted, not enforced (trust doc 1b). */
  human?: string
  /**
   * Set only by a gateway, on a record from an external domain: who sent it there.
   * A home node accepts this only from a gateway's origin; it is shown as data and
   * is never claimable.
   */
  foreign?: { domain: string; human: string; role: string; member?: string; xid: string; kind: string }
}

/** An envelope as read back from the transport, with the transport's own id. */
export type Posted = Envelope & {
  id: string
  /** Set when it arrived by routed delivery: the node that sent it, and that node's id for it. */
  remote?: { node: string; id: string }
}

export type MemberState = {
  name: string
  instance: string
  meta: Metadata
  roles: Set<string>
  joinedAt: number
}

export type RoleState = {
  name: string
  epoch: number
  deleted: boolean
  members: Set<string>
}

export type Registry = {
  roles: Map<string, RoleState>
  members: Map<string, MemberState>
}
