/**
 * FR-7 I5 — direct-link diagnostics (loopback-only detection).
 *
 * A driver node binds the graph/bus/API/UI to `127.0.0.1` by default, so it is not
 * inbound-reachable for the mesh unless it opts into a published bind (`CKN_MESH_BIND`,
 * see meshBind.ts). When such a loopback-only node ALSO has configured peers it can't
 * reach, every message to them must relay through a reachable node — for two NAT'd WSL
 * nodes (the roaming laptop case) that relay is a SPOF.
 *
 * This pure helper decides whether to surface the "enable WSL mirrored networking +
 * CKN_MESH_BIND for a DIRECT link" suggestion in mesh-status. It is ADVISORY: relay
 * stays a valid fallback, so it must never fire when a published bind is already set.
 */
import type { PeerCapability } from './meshState.js'

export interface DirectLinkHintInput {
  /** true once this node has opted into a published mesh-accept bind (CKN_MESH_BIND
   *  parsed OK) — then it is inbound-reachable and needs no hint. */
  bindConfigured: boolean
  /** the peers' per-edge dial verdicts (from mesh-status). An `unreachable` peer is
   *  one a probe could not reach AND that holds no inbound link to us — exactly the
   *  case a direct link would fix. */
  peers: { capability: PeerCapability }[]
}

/** A short, actionable direct-link hint, or `null` when none applies. */
export function meshDirectLinkHint(input: DirectLinkHintInput): string | null {
  if (input.bindConfigured) return null
  const unreachable = input.peers.filter((p) => p.capability === 'unreachable').length
  if (unreachable === 0) return null
  const s = unreachable === 1 ? '' : 's'
  return (
    `${unreachable} configured peer${s} unreachable and this node is loopback-only ` +
    `(no CKN_MESH_BIND) — messages can only relay through a reachable node. For a DIRECT ` +
    `link between NAT'd WSL nodes, enable WSL mirrored networking ` +
    `(.wslconfig "[wsl2] networkingMode=mirrored" then "wsl --shutdown"), then set ` +
    `CKN_MESH_BIND=<lan-ip>:<port> and CKN_MESH_SELF=http://<lan-ip>:<port>. Relay stays the fallback.`
  )
}
