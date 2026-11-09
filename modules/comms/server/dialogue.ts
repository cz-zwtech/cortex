/**
 * Bus messages as dialogue (core/dialogue.ts): what one session said to
 * another. Recorded where the message is seen (the sender's node on send, the
 * receiving node on delivery), because a routed copy leaves the sender's log
 * once it is delivered.
 *
 * Only text a session wrote. Commands and their results (a JSON body), silent
 * program replies, the mesh's own notices and every non-message envelope are
 * protocol, not dialogue.
 */
import crypto from 'node:crypto'

import { appendDialogue, isProtocolBody, type DialogueRecord } from '../../../core/dialogue.js'
import type { Envelope } from './types.js'

const memberOf = (from: string) => (from.includes('/') ? from.split('/')[1]! : from)

/** The same message has the same id on every node that records it. */
const idOf = (env: Envelope) => crypto.createHash('sha256').update(`${env.from}\n${env.to ?? ''}\n${env.stamp}\n${env.body ?? ''}`).digest('hex').slice(0, 24)

export const busRecord = (env: Envelope, member: string, ref?: string): DialogueRecord | undefined => {
  if (env.type !== 'msg' || env.silent || !env.body || env.from === 'cortex-mesh' || isProtocolBody(env.body)) return undefined
  const to = env.to ?? ''
  return {
    v: 1,
    id: idOf(env),
    at: env.stamp,
    // From another organisation, through the gateway: external data, kept apart from home dialogue.
    source: env.foreign ? 'external' : 'bus',
    from: { kind: 'member', name: memberOf(env.from) },
    to: { kind: to.includes('/') ? 'member' : 'role', name: to },
    text: env.body,
    ...(env.ref ? { replyTo: env.ref } : {}),
    member,
    ...(ref ? { ref } : {}),
  }
}

/** Record a message this node sent or received. Never throws. */
export const recordBus = (writer: 'send' | 'receive', env: Envelope, member: string, ref?: string): void => {
  try {
    const r = busRecord(env, member, ref)
    if (r) appendDialogue('comms', writer, [r])
  } catch {
    /* a dialogue line must never break delivery */
  }
}
