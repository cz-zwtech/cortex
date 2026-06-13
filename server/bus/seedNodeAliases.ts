import { getMachineId } from '../privateMind.js'
import { setAlias } from '../graph/nodeAliases.js'

/**
 * One-time, idempotent, best-effort. (1) Folds a fleet's known historical host ids
 * onto their current canonical id. (2) Pinning the anchor is a side effect of
 * getMachineId() (it writes the anchor when minting), so calling it here guarantees
 * self is pinned on first boot after the upgrade.
 *
 * Aliases are keyed by the DEFUNCT id, so they are safe to assert on every boot: if a
 * defunct id never appears in this DB, the alias simply never matches. The seed list
 * is FLEET-SPECIFIC and empty by default — if you migrated a node and want its old id
 * folded onto the new canonical one, add the pair here (defunct ids can't be discovered
 * automatically once the anchor pins the live id).
 */
const KNOWN_ALIASES: Array<[alias: string, canonical: string]> = [
  // e.g. ['old-host-id', 'current-canonical-id'] — add your fleet's migrated nodes here.
]

export function seedNodeAliases(): void {
  try {
    getMachineId() // pins self's anchor on first run post-upgrade
    for (const [alias, canonical] of KNOWN_ALIASES) setAlias(alias, canonical)
  } catch {
    /* never block startup */
  }
}
