/**
 * What comms publishes to code that runs inside its mesh daemon, where no module capabilities exist:
 * a gateway node runs the gateway in the daemon's process. Another module imports these from here
 * and nothing else of comms; anything not re-exported is comms' own and may change.
 */
export { decode, encode } from './envelope.js'
export { HELD } from './meshBridge.js'
export { ADDR } from './transport.js'
export type { Envelope } from './types.js'
export type { MeshLog } from './mesh/log.js'
export { chunksOf, safeName, sha256, type FileEntry } from './mesh/files.js'
export { NodeTable } from './mesh/nodes.js'
export { ACKS_ADDRESS, OUTBOX_ADDRESS, type Accept, type RouteOut } from './mesh/router.js'
export { EXTERNAL_ADDRESS, type ExternalNotice } from './mesh/view.js'
