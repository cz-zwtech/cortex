/**
 * The gateway's Prometheus metrics, as a textfile for node_exporter's textfile
 * collector: node_exporter already serves the internal interface to
 * `admin_allow` only (network notes), so no new port opens on the gateway.
 *
 * Crossings are counted from the audit chain (seeded from the file at start),
 * so the counters survive a restart and never disagree with the audit.
 */
import fs from 'node:fs'
import path from 'node:path'

import { readAudit, type AuditEntry } from './audit.js'

export const metricsFile = (dir: string) => path.join(dir, 'gateway.prom')

/** A banned source is an address: one label value per address would grow without bound. */
const peerLabel = (e: AuditEntry) => (e.dir === 'link' && e.decision === 'banned' ? '-' : e.peer)
const key = (e: AuditEntry) => `${e.dir}\u0000${e.decision}\u0000${peerLabel(e)}`

export class Crossings {
  #counts = new Map<string, number>()
  constructor(dir: string) {
    for (const l of readAudit(dir)) this.count(l)
  }
  count(e: AuditEntry): void {
    this.#counts.set(key(e), (this.#counts.get(key(e)) ?? 0) + 1)
  }
  entries(): { dir: string; decision: string; peer: string; n: number }[] {
    return [...this.#counts].map(([k, n]) => {
      const [dir, decision, peer] = k.split('\u0000') as [string, string, string]
      return { dir, decision, peer, n }
    })
  }
}

export type Gauges = {
  peers: { domain: string; linked: boolean }[]
  paths: number
  mailbox: number
  banned: number
  auditLines: number
  auditOk: boolean
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

export const renderMetrics = (c: Crossings, g: Gauges): string => {
  const out: string[] = []
  const metric = (name: string, type: 'counter' | 'gauge', help: string, rows: [Record<string, string>, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
    for (const [labels, v] of rows) {
      const l = Object.entries(labels).map(([k, x]) => `${k}="${esc(x)}"`).join(',')
      out.push(`${name}${l ? `{${l}}` : ''} ${v}`)
    }
  }
  metric('cortex_gateway_crossings_total', 'counter', 'Audited crossings by direction, decision and peer.', c.entries().map((e) => [{ dir: e.dir, decision: e.decision, peer: e.peer }, e.n]))
  metric('cortex_gateway_peer_linked', 'gauge', 'Whether the link to a peer gateway is up.', g.peers.map((p) => [{ peer: p.domain }, p.linked ? 1 : 0]))
  metric('cortex_gateway_return_paths', 'gauge', 'Open return paths.', [[{}, g.paths]])
  metric('cortex_gateway_mailbox', 'gauge', 'Inbound records held for home, not yet read.', [[{}, g.mailbox]])
  metric('cortex_gateway_banned_sources', 'gauge', 'Sources banned now for failed handshakes.', [[{}, g.banned]])
  metric('cortex_gateway_audit_lines', 'gauge', 'Lines in the audit chain.', [[{}, g.auditLines]])
  metric('cortex_gateway_audit_ok', 'gauge', 'Whether the audit chain verified at its last check (1) or is broken (0).', [[{}, g.auditOk ? 1 : 0]])
  return out.join('\n') + '\n'
}

/** Written atomically, so node_exporter never reads half a file. Also to CKN_GATEWAY_TEXTFILE_DIR, when set. */
export const writeMetrics = (dir: string, text: string, env: NodeJS.ProcessEnv = process.env): void => {
  for (const d of [dir, env.CKN_GATEWAY_TEXTFILE_DIR].filter((x): x is string => !!x)) {
    const file = metricsFile(d)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  }
}
