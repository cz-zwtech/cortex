/**
 * Whether this node connects to others, as a setting rather than an install (2 Nov 2026):
 * local-only is the default, with no daemon, no open port and no outbound link, since messages
 * on one machine go through the local log alone. The node connects when it listens (other nodes
 * may dial in) or has peers to dial; adding a peer or turning listening on starts the daemon,
 * and turning both off stops it. No reinstall, no new code.
 */
import fs from 'node:fs'
import path from 'node:path'

import { start, stop } from './control.js'
import { readNodeConfig, writeNodeConfig } from './nodeConfig.js'
import { readPeers } from './peers.js'

export type Migrated = { wrote: boolean; listen: boolean; why: string }

/** What a node from before the setting did: listen if it is a gateway or other nodes dialed in. */
const inferred = (dir: string): { listen: boolean; why: string } => {
  const cfg = readNodeConfig(dir)
  let calledIn = false
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf-8')) as { links?: { direction?: string }[] }
    calledIn = (s.links ?? []).some((l) => l.direction === 'in')
  } catch {
    /* never ran: nobody has dialed in */
  }
  const listen = cfg.intent === 'gateway' || calledIn
  return { listen, why: cfg.intent === 'gateway' ? 'a gateway' : calledIn ? 'other nodes dial in here' : 'nobody dials in here' }
}

/**
 * Whether this node listens: its setting, or, until one is written, what it did before. Every reader
 * goes through here, so a node that never reran install (a gateway, say) keeps listening across
 * restarts and peer changes instead of reading an unset value as off. Reading writes nothing.
 */
export const listens = (dir: string): boolean => readNodeConfig(dir).listen ?? inferred(dir).listen

export const connects = (dir: string): boolean => listens(dir) || readPeers(dir).length > 0

/**
 * Once, on a node from before the setting: listen if it is a gateway or other nodes have dialed in
 * (its last status shows a link that called in); otherwise not. Peers already configured stay.
 */
export const migrateConnect = (dir: string): Migrated => {
  const cfg = readNodeConfig(dir)
  if (cfg.listen !== undefined) return { wrote: false, listen: cfg.listen, why: 'already set' }
  const { listen, why } = inferred(dir)
  writeNodeConfig(dir, { listen })
  return { wrote: true, listen, why }
}

/** Make the daemon match the setting: running when the node connects, stopped when it does not. */
export const applyConnect = async (dir: string): Promise<'started' | 'already' | 'failed' | 'stopped' | 'not-running'> =>
  connects(dir) ? start(dir, { wait: true }) : stop(dir)
