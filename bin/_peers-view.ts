/**
 * Read-side presence view helpers for `ckn-bus`.
 *
 * With the anchor model (pruneStaleSessions.ts), a signed_off row is RETAINED as
 * a durable identity anchor until the 90d cap — great for resume rebinding, but
 * it would clutter the human roster. The default `ckn-bus peers` view therefore
 * hides signed_off; `--all` shows them. This is a DISPLAY filter only — addressing
 * (send/reply/whoami/resolveRecipient) still reads the full `/peers` set, so you
 * can still leave a message for an offline (signed_off) session.
 */

/** Filter a presence list for display. Excludes `signed_off` rows unless
 *  `includeSignedOff`. Order-preserving; status-only (never drops live/idle/stale). */
export function visiblePeers<T extends { status: string }>(
  peers: T[],
  includeSignedOff: boolean,
): T[] {
  if (includeSignedOff) return peers
  return peers.filter((p) => p.status !== 'signed_off')
}
