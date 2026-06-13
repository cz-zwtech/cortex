/**
 * Mesh mutual-auth proof primitive (FR slice #4). The fleet token authenticates a
 * node WITHOUT ever being transmitted: a node proves possession by returning an
 * HMAC-SHA256 over a shared context, keyed by the token. The verifier recomputes
 * the same HMAC and constant-time compares — neither side ever puts the token on
 * the wire (the bearer-purge invariant). Used by:
 *   - the HTTP per-request signature (meshAuth meshHeaders/meshAuthMiddleware), and
 *   - the WS in-band post-open handshake (meshWs), where role-binding the context
 *     (`…||dialer` vs `…||peer`) makes the two proofs differ so a peer's proof can't
 *     be reflected back as the dialer's.
 *
 * No PKI, no deps — Node's built-in crypto. The token NEVER appears in any output.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Scheme version, prefixed into every signed context (request, response, handshake).
 * Binds a proof to THIS MAC construction: a future scheme bumps this so a v1 proof can
 * never be replayed or confused against a v2 verifier. Hard cutover — both ends share
 * one version per deploy; there is no cross-version negotiation.
 */
export const MAC_VERSION = 'v1'

/**
 * HMAC-SHA256 of `context`, keyed by the fleet `token`, as lowercase hex. The token
 * is the HMAC KEY and is never recoverable from (nor present in) the returned mac.
 */
export function signMac(token: string, context: string): string {
  return createHmac('sha256', token).update(context).digest('hex')
}

/**
 * Constant-time verification that `mac` equals `signMac(token, context)`. Fail-closed:
 * an empty token/mac, or a length mismatch (e.g. truncated mac), returns false without
 * short-circuiting on length — an attacker can't learn the expected length from timing.
 * Never throws.
 */
export function verifyMac(token: string, context: string, mac: string): boolean {
  if (!token || !mac) return false
  const expected = Buffer.from(signMac(token, context), 'utf8')
  const presented = Buffer.from(String(mac), 'utf8')
  if (expected.length !== presented.length) {
    // Equalize timing against a same-length buffer; timingSafeEqual throws on a
    // length mismatch, so never compare the two directly here.
    timingSafeEqual(expected, expected)
    return false
  }
  return timingSafeEqual(expected, presented)
}

// ── HTTP per-request signing (slice #4B) ─────────────────────────────────────────
//
// Replaces `Authorization: Bearer <token>` on inter-node HTTP calls. The dialer
// signs the request shape; the receiver recomputes + verifies and proves BACK over
// the request nonce (mutual). The token is the HMAC key — never transmitted.

/** Header names carrying the request proof + the peer's mutual proof-back. */
export const SIG_NONCE_HEADER = 'x-mesh-nonce'
export const SIG_TS_HEADER = 'x-mesh-ts'
export const SIG_HEADER = 'x-mesh-sig'
export const RESP_SIG_HEADER = 'x-mesh-resp-sig'

/** Clock-skew + replay window: a request whose ts is more than this from the
 *  verifier's clock is rejected. Within the window, a nonce-replay CACHE
 *  (`meshNonceCache.ts`) rejects a re-seen nonce, so a captured signed request can't
 *  be replayed verbatim; the window bounds how long a nonce must be remembered. */
export const SIG_SKEW_MS = 60_000

/** sha256 hex of the exact request body STRING the dialer sends (JSON.stringify
 *  output), so the receiver hashes the same bytes (captured via express.json verify). */
export function bodyHash(body: string): string {
  return createHash('sha256').update(body ?? '').digest('hex')
}

/** The signed request context. Binds method + request-target + body + nonce + ts,
 *  so tampering with ANY of them invalidates the proof. */
function reqContext(
  method: string,
  pathname: string,
  bodyStr: string,
  nonce: string,
  ts: string | number,
): string {
  return `${MAC_VERSION}|${method.toUpperCase()}|${pathname}|${bodyHash(bodyStr)}|${nonce}|${ts}`
}

export interface RequestSig {
  nonce: string
  ts: string
  sig: string
}

/** Sign an outbound inter-node request. `opts.nonce`/`opts.now` are injectable for
 *  deterministic tests; in production a fresh random nonce + the current clock. */
export function signRequest(
  token: string,
  method: string,
  pathname: string,
  bodyStr = '',
  opts?: { nonce?: string; now?: number },
): RequestSig {
  const nonce = opts?.nonce ?? randomBytes(16).toString('hex')
  const ts = String(opts?.now ?? Date.now())
  const sig = signMac(token, reqContext(method, pathname, bodyStr, nonce, ts))
  return { nonce, ts, sig }
}

/** Verify an inbound inter-node request: constant-time sig check + a ±SIG_SKEW_MS
 *  freshness gate. Fail-closed on any missing/malformed field. Never throws. */
export function verifyRequest(
  token: string,
  v: {
    method: string
    pathname: string
    bodyStr: string
    nonce: string
    ts: string
    sig: string
    now?: number
  },
): boolean {
  if (!token || !v.nonce || !v.ts || !v.sig) return false
  const t = Number(v.ts)
  if (!Number.isFinite(t)) return false
  if (Math.abs((v.now ?? Date.now()) - t) > SIG_SKEW_MS) return false
  return verifyMac(token, reqContext(v.method, v.pathname, v.bodyStr, v.nonce, v.ts), v.sig)
}

/** The peer's mutual proof-back, bound to the request's nonce: only a holder of the
 *  token can produce it, so the dialer learns the peer is a genuine fleet member. */
export function signResponse(token: string, reqNonce: string): string {
  return signMac(token, `${MAC_VERSION}|${reqNonce}|resp`)
}

/** Dialer-side verification of the peer's proof-back. */
export function verifyResponse(token: string, reqNonce: string, mac: string): boolean {
  return verifyMac(token, `${MAC_VERSION}|${reqNonce}|resp`, mac)
}
