import type { Envelope, Posted } from './types.js'

/**
 * Envelopes travel as the BODY of a transport message, prefixed so they can
 * never be confused with a human-written body on the same transport.
 */
export const ENVELOPE_PREFIX = 'cortex.comms/1 '

export const encode = (e: Envelope): string => ENVELOPE_PREFIX + JSON.stringify(e)

/** Null for anything that is not one of ours, including malformed JSON. */
export const decode = (id: string, body: string): Posted | null => {
  if (!body.startsWith(ENVELOPE_PREFIX)) return null
  try {
    const e = JSON.parse(body.slice(ENVELOPE_PREFIX.length)) as Envelope
    if (e?.v !== 1 || typeof e.type !== 'string' || typeof e.stamp !== 'number') return null
    return { ...e, id }
  } catch {
    return null
  }
}

/**
 * The one total order every node agrees on: posted stamp, then id.
 *
 * Ids are minted by the transport and unique, so the order is total. Clock skew
 * changes WHICH envelope sorts first, never whether two nodes agree on it.
 */
export const byPostedOrder = (a: Posted, b: Posted): number =>
  a.stamp - b.stamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
