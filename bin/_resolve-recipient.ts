/**
 * Send-side recipient resolution for `ckn-bus` — resolve a `--to` token
 * (sessionId / metaId / friendlyName / `name@machine` / '*') to a concrete bus
 * address. Extracted from ckn-bus.ts so the name-tie rules are unit-testable
 * without running the CLI.
 *
 * Only LIVE/idle rows are ADDRESSABLE: a signed_off/stale row that still wears a
 * friendly name (e.g. a reaped bootstrap phantom) must never count as a candidate
 * or fabricate false ambiguity. Among live same-machine ties, the transcript-
 * backed row (this host's real session) wins — the same ground truth the
 * presence-side fixes use.
 */
export interface Peer {
  sessionId: string
  friendlyName: string
  machine: string
  cwd: string
  status: string
  metaId?: string
  nameHistory?: string[]
}

export interface ResolveOpts {
  /** True iff `sessionId` has a validated `<id>.jsonl` transcript on THIS host —
   *  used to break a live same-machine name tie. Omit for no tie-break. */
  isLocalTranscript?: (sessionId: string) => boolean
  /** How to signal an unresolvable ambiguity. Defaults to throwing; ckn-bus
   *  passes its `die` (stderr + process.exit). */
  die?: (msg: string) => never
}

// Durable target for a matched peer: prefer metaId (follows the peer through
// rename + resume + new-session-reclaim), else sessionId.
export const targetOf = (p: Peer): string => (p.metaId && p.metaId.trim()) || p.sessionId

const ADDRESSABLE = new Set(['live', 'idle'])

export function resolveRecipient(to: string, peers: Peer[], fromMachine: string, opts: ResolveOpts = {}): string {
  const die = opts.die ?? ((m: string): never => { throw new Error(m) })
  const list = (cands: Peer[]) => cands.map((p) => `  ${p.sessionId}  (${p.status})`).join('\n')

  // Among candidates, the unique transcript-backed one (this host's real
  // session) breaks a live tie; null when there's no unique winner.
  const tieBreak = (cands: Peer[]): Peer | undefined => {
    if (!opts.isLocalTranscript) return undefined
    const backed = cands.filter((p) => opts.isLocalTranscript!(p.sessionId))
    return backed.length === 1 ? backed[0] : undefined
  }

  if (to === '*') return to
  // Exact session id or metaId — pass through (preserves reply/ack targeting).
  if (peers.find((p) => p.sessionId === to || p.metaId === to)) return to

  const at = to.lastIndexOf('@') // names never contain '@'
  const name = at >= 0 ? to.slice(0, at) : to
  const pinnedMachine = at >= 0 ? to.slice(at + 1) : undefined

  const byName = peers.filter((p) => p.friendlyName === name || (p.nameHistory ?? []).includes(name))
  if (byName.length === 0) return to // unknown name → ride the stream; probe surfaces it

  // Only LIVE/idle rows are addressable. A signed_off/stale bearer of the name
  // (a reaped phantom, a dead session) is NOT a candidate.
  const addressable = byName.filter((p) => ADDRESSABLE.has(p.status))
  if (addressable.length === 0) return to // name known but no live bearer → probe surfaces it

  if (pinnedMachine) {
    const cands = addressable.filter((p) => p.machine === pinnedMachine)
    if (cands.length === 0) {
      const machines = [...new Set(addressable.map((p) => p.machine || '(unknown)'))]
      die(`no live peer named '${name}' on machine '${pinnedMachine}'. Live on: ${machines.join(', ')}`)
    }
    if (cands.length === 1) return targetOf(cands[0]!)
    const w = tieBreak(cands)
    if (w) return targetOf(w)
    die(`'${name}@${pinnedMachine}' is ambiguous (${cands.length} live sessions). Use a session id:\n${list(cands)}`)
  }

  // No pin: prefer a peer on the sender's machine.
  const local = addressable.filter((p) => fromMachine && p.machine === fromMachine)
  if (local.length === 1) return targetOf(local[0]!)
  if (local.length > 1) {
    const w = tieBreak(local)
    if (w) return targetOf(w)
    die(`'${name}' is ambiguous on this machine (${local.length} live sessions). Use a session id:\n${list(local)}`)
  }

  // No local match: require a unique remote match (transcript tie-break can't help
  // across machines — this host doesn't see remote transcripts).
  if (addressable.length === 1) return targetOf(addressable[0]!)
  const machines = [...new Set(addressable.map((p) => p.machine || '(unknown)'))]
  if (machines.length > 1) {
    die(
      `'${name}' is ambiguous across machines: ${machines.join(', ')}. ` +
        `Disambiguate with '${name}@<machine>' or a session id:\n` +
        addressable.map((p) => `  ${p.sessionId}  @${p.machine || '(unknown)'}  (${p.status})`).join('\n'),
    )
  }
  const w = tieBreak(addressable)
  if (w) return targetOf(w)
  return die(`'${name}' is ambiguous (${addressable.length} live sessions on ${machines[0]}). Use a session id:\n${list(addressable)}`)
}
