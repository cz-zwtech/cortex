/**
 * HTTP nonce-replay cache for the mesh per-request proof (slice #4D, v0-required).
 *
 * The signature + ±SIG_SKEW_MS freshness gate stop a tampered or stale request, but a
 * VALIDLY-signed one captured inside the window could be replayed verbatim and re-run
 * — and a mesh `ingest`/`state` POST carrying humanProvenance is NOT idempotent, so a
 * replay is an authority-replay + double-inject. This rejects a re-seen nonce until it
 * expires (TTL = SIG_SKEW_MS; past that the freshness gate already rejects it, so the
 * entry is evictable). HTTP path only — WS nonces are per-handshake and server-issued.
 *
 * Call ONLY after the signature verifies, so unauthenticated junk (which lacks the
 * token and so can't be a valid replay) never floods the cache. In-memory + lazy-pruned.
 */
import { SIG_SKEW_MS } from './meshProof.js'

const seen = new Map<string, number>() // nonce -> expiry (ms epoch)
/** Prune expired entries once the map grows past this; amortizes eviction to O(1). */
const PRUNE_AT = 10_000

function prune(now: number): void {
  for (const [nonce, exp] of seen) if (exp <= now) seen.delete(nonce)
}

/**
 * Record a validly-signed request's nonce. Returns false if it was already seen and
 * not yet expired (a replay within the freshness window) — the caller 401s — or true
 * if fresh (now recorded with a SIG_SKEW_MS TTL).
 */
export function recordNonce(nonce: string, now: number = Date.now()): boolean {
  if (seen.size >= PRUNE_AT) prune(now)
  const exp = seen.get(nonce)
  if (exp !== undefined && exp > now) return false // replay within the window
  seen.set(nonce, now + SIG_SKEW_MS)
  return true
}

/** Test seam: clear the cache between cases. */
export function _resetNonceCache(): void {
  seen.clear()
}
