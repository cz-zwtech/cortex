/**
 * Mesh transport auth: a single fleet token gating `/api/mesh/*` — but the token is
 * NEVER transmitted (slice #4 bearer-purge). Each request carries a per-request
 * HMAC PROOF of token possession (meshHeaders → meshProof); the middleware
 * recomputes + constant-time verifies and proves BACK over the request nonce.
 *
 * Federation doctrine is "machines are one user's voice", so every node holds the
 * SAME token (`CKN_MESH_TOKEN`, fetched at the launcher via `bao-run` from OpenBao —
 * never baked into a file or logged). The mesh is an inter-machine write surface;
 * without auth anyone on the network could spoof `fromSession`, so the tier is
 * FAIL-CLOSED: peers configured but no token ⇒ mesh stays off.
 */
import type { IncomingMessage } from 'node:http'
import type { RequestHandler } from 'express'
import { peerUrls } from './meshIdentity.js'
import {
  signRequest,
  verifyRequest,
  signResponse,
  SIG_NONCE_HEADER,
  SIG_TS_HEADER,
  SIG_HEADER,
  RESP_SIG_HEADER,
} from './meshProof.js'
import { recordNonce } from './meshNonceCache.js'

// Runtime-acquired token cache (FR-7 D2): when CKN_MESH_TOKEN is not in the env
// (e.g. a node that booted with no reachable OpenBao), the membership controller
// fetches it at RUNTIME via CKN_MESH_TOKEN_CMD/bao-run and caches it here so the
// whole tier — which all routes through meshToken() — activates without a restart.
// The env value ALWAYS wins; this is only the fallback. Never logged.
let runtimeToken = ''
/** Cache a runtime-fetched fleet token (meshTokenSource). env still takes precedence. */
export function setRuntimeMeshToken(token: string): void {
  runtimeToken = token
}
/** Drop the cached runtime token (e.g. the source went away → fail-closed again). */
export function clearRuntimeMeshToken(): void {
  runtimeToken = ''
}

/** The fleet token (HMAC key, never transmitted): env CKN_MESH_TOKEN if set, else the
 *  runtime-cached one, else ''. */
export function meshToken(): string {
  return process.env.CKN_MESH_TOKEN || runtimeToken
}

let warnedMissingToken = false

/**
 * Whether the mesh tier may activate. Fail-closed: a configured peer list with
 * no token is a misconfiguration we refuse to honor (it would expose an
 * unauthenticated cross-machine write surface), so warn once and stay off.
 */
export function meshEnabled(): boolean {
  const hasPeers = peerUrls().length > 0
  const hasToken = meshToken() !== ''
  if (hasPeers && !hasToken) {
    if (!warnedMissingToken) {
      warnedMissingToken = true
      console.warn(
        '[ckn] mesh: CKN_MESH_PEERS set but CKN_MESH_TOKEN missing — mesh DISABLED',
      )
    }
    return false
  }
  // Token present = opt into the mesh. A node ALWAYS accepts authed inbound WS and
  // dials out only if it has a peer dial-list, so an accept-only node (token set,
  // empty CKN_MESH_PEERS) is validly enabled — `hasPeers` is NOT required.
  return hasToken
}

/**
 * Reject any `/api/mesh/*` request whose per-request HMAC proof doesn't verify
 * (slice #4B). The fleet token is NEVER transmitted: the dialer signs
 * method||path||bodyHash||nonce||ts keyed by the token, and we recompute + constant-
 * time compare with a ±SIG_SKEW_MS freshness gate (`verifyRequest`). On success we
 * set RESP_SIG_HEADER so the dialer can verify WE hold the token too (mutual). The
 * body bytes are the raw request body captured by `express.json({ verify })` — we
 * hash exactly what the dialer hashed. Fail-closed: an empty token never authorizes.
 */
export const meshAuthMiddleware: RequestHandler = (req, res, next) => {
  const token = meshToken()
  if (!token) {
    res.status(401).json({ error: 'mesh auth' })
    return
  }
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody
  const nonce = String(req.headers[SIG_NONCE_HEADER] ?? '')
  const ok = verifyRequest(token, {
    method: req.method,
    pathname: req.originalUrl,
    bodyStr: rawBody instanceof Buffer ? rawBody.toString('utf8') : '',
    nonce,
    ts: String(req.headers[SIG_TS_HEADER] ?? ''),
    sig: String(req.headers[SIG_HEADER] ?? ''),
    now: Date.now(),
  })
  if (!ok) {
    res.status(401).json({ error: 'mesh auth' })
    return
  }
  // Replay gate (only AFTER the signature verifies, so junk can't flood the cache): a
  // validly-signed request whose nonce was already seen inside the freshness window is
  // a replay — verbatim re-execution of a non-idempotent, humanProvenance-carrying POST.
  if (!recordNonce(nonce)) {
    res.status(401).json({ error: 'mesh auth' })
    return
  }
  res.setHeader(RESP_SIG_HEADER, signResponse(token, nonce)) // mutual: prove possession back
  next()
}

/**
 * Gate the `/api/mesh/ws` WebSocket UPGRADE. Auth moved IN-BAND (slice #4C): the
 * socket opens UNPRIVILEGED and the `MeshHandshake` authenticates post-open — the
 * token is never transmitted. We still only ACCEPT the upgrade when this node is ON
 * the mesh (a token is configured), so a mesh-off node never opens a mesh socket; an
 * unproven peer is then closed by the handshake. The request is no longer inspected
 * (kept in the signature for the caller).
 */
export function meshUpgradeAuthorized(_req: IncomingMessage): boolean {
  return meshToken() !== ''
}

/**
 * Outbound headers for inter-node POST/GET calls: a per-request HMAC proof of token
 * possession — the token itself is NEVER sent (slice #4B). The caller passes the
 * exact method, request-target (path[?query]), and body STRING it will send, so the
 * receiver verifies the same bytes. Read the nonce back from the returned headers
 * (`SIG_NONCE_HEADER`) to verify the peer's mutual proof-back via `verifyResponse`.
 */
export function meshHeaders(
  method: string,
  pathname: string,
  bodyStr = '',
): Record<string, string> {
  const { nonce, ts, sig } = signRequest(meshToken(), method, pathname, bodyStr)
  return {
    'content-type': 'application/json',
    [SIG_NONCE_HEADER]: nonce,
    [SIG_TS_HEADER]: ts,
    [SIG_HEADER]: sig,
  }
}
