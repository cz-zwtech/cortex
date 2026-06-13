/**
 * FR-7 I4 — opt-in published mesh-accept bind. ⚠ SECURITY: this is the only path by
 * which a driver node listens OFF loopback, so it is deliberately minimal and
 * fail-closed.
 *
 * The main HTTP listener (server/index.ts) binds `127.0.0.1` on a driver node, which
 * keeps the graph/bus/API/UI off the network — but also makes the node not
 * inbound-reachable for the mesh. This module opens a SECOND, dedicated listener on
 * `CKN_MESH_BIND` that serves ONLY the `/api/mesh/ws` upgrade:
 *
 *   - It is a BARE `http.Server` with NO express app attached, so every HTTP request
 *     gets a 404 — the graph/bus/REST/UI can never leak on this port. "Reachable for
 *     mesh" ≠ "graph/bus/API exposed."
 *   - Only the `/api/mesh/ws` upgrade is honored, behind the SAME upgrade gate as the
 *     loopback listener (`meshUpgradeAuthorized`): fail-closed on no token, otherwise
 *     UNPRIVILEGED — the token is never sent as a bearer; the in-band mutual handshake
 *     (slice #4C) establishes trust after the socket opens. The PTY `/ws` and every
 *     other path are destroyed.
 *
 * Default OFF: unset `CKN_MESH_BIND` ⇒ no listener. The threat model (and the
 * recommended posture) is in docs + `2026-06-07-fr7-build-plan.md` §I4 — prefer a
 * SPECIFIC LAN/VLAN ip over `0.0.0.0`, never enable on an untrusted network without a
 * specific-ip bind + host firewall.
 */
import { createServer, type Server } from 'node:http'
import { WebSocketServer } from 'ws'
import { meshUpgradeAuthorized } from './meshAuth.js'
import { acceptPeer } from './meshWs.js'

export interface MeshBindConfig {
  host: string
  port: number
}

/**
 * Parse `CKN_MESH_BIND` into a published-bind config, or `null` when unset/invalid
 * (feature OFF — the default). Accepts `host:port`, `:port`, or a bare `port`; a bare
 * port or `:port` binds all interfaces (`0.0.0.0`). A specific host is recommended by
 * the threat model. IPv6 literals are out of scope (use a hostname or IPv4). Invalid
 * or out-of-range ports ⇒ `null` (stays OFF rather than binding somewhere surprising).
 */
export function meshBindConfig(raw: string | undefined = process.env.CKN_MESH_BIND): MeshBindConfig | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  let host = '0.0.0.0'
  let portStr = v
  const lastColon = v.lastIndexOf(':')
  if (lastColon >= 0) {
    const h = v.slice(0, lastColon).trim()
    portStr = v.slice(lastColon + 1).trim()
    if (h) host = h
  }
  const port = Number(portStr)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port }
}

// One noServer handshake helper for accepted mesh sockets on the published port. An
// accepted ws becomes a Link via acceptPeer, exactly like the loopback listener.
const wssMeshBind = new WebSocketServer({ noServer: true })
let meshBindServer: Server | null = null

/**
 * Start the opt-in published mesh-accept listener. Returns the bound port (useful with
 * `port: 0` in tests) or `null` when OFF / a bind error occurs. Idempotent: a second
 * call while already listening is a no-op (returns null). Pass an explicit config to
 * override `CKN_MESH_BIND` (tests pass `{host:'127.0.0.1', port:0}` for an ephemeral
 * loopback port).
 */
export function startMeshBind(cfg: MeshBindConfig | null = meshBindConfig()): Promise<number | null> {
  if (!cfg || meshBindServer) return Promise.resolve(null)
  // Bare http server: NO express app ⇒ every request 404s. App routes/UI cannot be
  // served here — only the mesh upgrade below.
  const srv = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain', connection: 'close' })
    res.end('cortex mesh-bind: mesh upgrade only\n')
  })
  srv.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    if (pathname !== '/api/mesh/ws') {
      // PTY `/ws` and everything else are NOT exposed on the published port.
      socket.destroy()
      return
    }
    if (!meshUpgradeAuthorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wssMeshBind.handleUpgrade(req, socket, head, (ws) => acceptPeer(ws))
  })
  meshBindServer = srv
  return new Promise((resolve) => {
    srv.once('error', (e: Error) => {
      console.warn(`[ckn] mesh-bind listen error on ${cfg.host}:${cfg.port}: ${e.message}`)
      meshBindServer = null
      resolve(null)
    })
    srv.listen(cfg.port, cfg.host, () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : cfg.port
      const exposure = cfg.host === '0.0.0.0' ? ' (ALL interfaces — prefer a specific LAN ip)' : ''
      console.log(
        `[ckn] published mesh-accept bind on ${cfg.host}:${port}${exposure} — ` +
          `mesh upgrade only; graph/bus/API/UI stay on the loopback listener`,
      )
      resolve(port)
    })
  })
}

/** Stop the published mesh-accept listener (idempotent). The loopback listener is
 *  untouched. Accepted Links are owned by meshWs (stopWsMesh closes them). */
export function stopMeshBind(): void {
  if (!meshBindServer) return
  try {
    meshBindServer.close()
  } catch {
    /* already closing */
  }
  meshBindServer = null
}
