/**
 * The gateway module (trust doc sections 1 to 9; build plan
 * docs/cortex/2026-10-21-gateway-p7-build-plan.md).
 *
 * The gateway runs inside the mesh daemon of a node started with intent
 * `gateway` (cortex-mesh serve), so it shares that daemon's log, router and
 * node table. This entry only reports status for cortex-status.
 */
import fs from 'node:fs'
import path from 'node:path'

import type { CortexModule, ModuleHealth } from '../../../core/ctx.js'
import { readGatewayStatus } from './status.js'

const mod: CortexModule = {
  status(ctx): ModuleHealth {
    if (!fs.existsSync(path.join(ctx.dataDir, 'gateway.json'))) return { summary: 'not configured (cortex-install --gateway)' }
    const s = readGatewayStatus(ctx.dataDir)
    if (!s) return { summary: 'configured; the mesh daemon has not started it yet', warnings: ['the gateway is configured but not running: cortex-mesh start'] }
    const up = s.peers.filter((p) => p.linked).length
    return {
      summary: `domain ${s.domain} on :${s.port}; ${up} of ${s.peers.length} peer gateway(s) linked; ${s.paths} open return path(s)`,
      ...(s.banned.length ? { warnings: [`banned sources: ${s.banned.join(', ')}`] } : {}),
    }
  },
}
export default mod
