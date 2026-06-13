/**
 * In-process pub/sub for "a bus message just landed in this node's store".
 *
 * Decouples the store (`sendMessage` / `ingestMeshMessage` in
 * server/graph/bus.ts emit here) from the transport (the `/api/bus/stream` SSE
 * endpoint subscribes), so a message surfaces to a watching session instantly
 * instead of on its next poll tick — whether it was locally sent or
 * mesh-ingested from a peer.
 *
 * Mesh (M2.1) adds an optional `fromPeerNode` tag carried alongside each event:
 * the WS forwarder uses it as an echo-guard so a message/state replicated from
 * peer X is not forwarded straight back to X (no loops). `undefined` means
 * local origin (a locally-sent message or a local ack/delivered). Existing
 * subscribers that take only `(row)` are unaffected — the extra arg is ignored.
 */
import { EventEmitter } from 'node:events'
import type { BusMessageRow } from '../graph/_rows.js'

const MSG_EVENT = 'msg'
const STATE_EVENT = 'state'

const emitter = new EventEmitter()
// One listener per watching local session plus one per connected mesh link; the
// default cap of 10 is far too low for a busy node. Raise it generously rather
// than leak a warning.
emitter.setMaxListeners(1000)

/** A state-only mesh event — delivered/ack/status changed for a known message,
 * but no new message landed. Mirrors `applyMeshState`'s arguments. */
export interface BusStateEvent {
  id: string
  deliveredTo: string[]
  ackedBy: string[]
  status: string
}

/**
 * Announce a message that just landed in the local store. `fromPeerNode` tags
 * the mesh peer it was replicated from (undefined = local origin) so a forwarder
 * can avoid echoing it back to that peer.
 */
export function emitBusMessage(row: BusMessageRow, fromPeerNode?: string): void {
  emitter.emit(MSG_EVENT, row, fromPeerNode)
}

/** Subscribe to landed messages. The callback receives the row plus the peer it
 * arrived from (undefined = local). Returns an unsubscribe function. */
export function onBusMessage(
  fn: (row: BusMessageRow, fromPeerNode?: string) => void,
): () => void {
  emitter.on(MSG_EVENT, fn)
  return () => emitter.off(MSG_EVENT, fn)
}

/**
 * Announce a state-only change (delivered/ack/status) for an existing message.
 * `fromPeerNode` tags the mesh peer it was applied from (undefined = local
 * ack/delivered) so a forwarder can avoid echoing it back to that peer.
 */
export function emitBusState(state: BusStateEvent, fromPeerNode?: string): void {
  emitter.emit(STATE_EVENT, state, fromPeerNode)
}

/** Subscribe to state-only changes. The callback receives the state plus the
 * peer it arrived from (undefined = local). Returns an unsubscribe function. */
export function onBusState(
  fn: (state: BusStateEvent, fromPeerNode?: string) => void,
): () => void {
  emitter.on(STATE_EVENT, fn)
  return () => emitter.off(STATE_EVENT, fn)
}
