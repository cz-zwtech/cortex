import type { Posted } from './types.js'

/**
 * Who owns a work message. The rule, kept exactly that simple:
 *
 *   - a claim carries the claimant's own posted wall-clock stamp
 *   - the earliest posted stamp is the owner
 *   (a) exact-equal stamps break ties by member name
 *   (b) once a `started` is posted, the work is that member's: a claim that
 *       arrives later loses even with an earlier stamp
 *
 * When two members have BOTH posted `started` (a claim delayed past the settle
 * window, e.g. a network split), rule (b) cannot pick a side, so the plain rule
 * decides between the started members. That is also what the fencing check uses.
 */

const memberOf = (from: string): string => (from.includes('/') ? from.split('/')[1]! : from)

/** Earliest posted stamp first; rule (a), exact ties, by member name. */
const byStampThenName = (a: Posted, b: Posted): number => {
  if (a.stamp !== b.stamp) return a.stamp - b.stamp
  const [ma, mb] = [memberOf(a.from), memberOf(b.from)]
  return ma < mb ? -1 : ma > mb ? 1 : 0
}

const earliest = (xs: Posted[]): Posted | undefined => [...xs].sort(byStampThenName)[0]

export type Ownership =
  | { state: 'unclaimed' }
  | { state: 'claimed'; owner: string; claimId: string }
  | { state: 'started'; owner: string }
  | { state: 'done'; owner: string }

export const ownership = (msgId: string, posted: Posted[]): Ownership => {
  const started = posted.filter((p) => p.type === 'started' && p.ref === msgId)
  if (started.length) {
    const owner = memberOf(earliest(started)!.from)
    // Only the owner can finish it; a done from anyone else changes nothing.
    if (posted.some((p) => p.type === 'done' && p.ref === msgId && memberOf(p.from) === owner)) return { state: 'done', owner }
    return { state: 'started', owner }
  }
  const claims = posted.filter((p) => p.type === 'claim' && p.ref === msgId)
  if (!claims.length) return { state: 'unclaimed' }
  const w = earliest(claims)!
  return { state: 'claimed', owner: memberOf(w.from), claimId: w.id }
}

/**
 * Fencing: may `member` still act on `msgId`?
 *
 * True only when the member is the owner by the rules above. Call it right
 * before an irreversible step. A member that lost a claim it thought it held,
 * because an earlier-stamped started surfaced after a split healed, gets false
 * and must stop.
 */
export const stillOwner = (member: string, msgId: string, posted: Posted[]): boolean => {
  const o = ownership(msgId, posted)
  return (o.state === 'claimed' || o.state === 'started') && o.owner === member
}
