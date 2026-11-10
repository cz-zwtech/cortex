#!/usr/bin/env tsx
/**
 * cortex-gate: the domain gateway, run on the gateway node.
 *
 *   status          domain, port, peer links, open return paths, mailbox, banned sources
 *   key             this gateway's pin, for a peer gateway's owner to pin by hand
 *   check           read gateway.json and say what is wrong with it, if anything
 *   paths [--all]   open return paths (internal role <- external role), last used; --all adds closed ones
 *   paths close <role> <domain>:<role>
 *                   close a return path on this box (when no session at home is left to close-return it);
 *                   the running gateway closes it and audits it
 *   audit [--tail N] [--verify]
 *                   the last N crossings (default 20); --verify walks the hash chain and exits 1,
 *                   naming the line, if any line was edited, removed or reordered
 *
 * Read-only. The gateway itself runs inside the mesh daemon (intent gateway).
 */
import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

import { dataRoot } from '../../../core/paths.js'
import { readAudit, verifyAudit } from '../server/audit.js'
import { readConfig, exposedToDomain } from '../server/config.js'
import { certFile, pinOfCert } from '../server/keys.js'
import { readGatewayStatus } from '../server/status.js'
import { exitOnHelp } from '../../../core/help.js'

exitOnHelp(`usage: cortex-gate status | key | check | paths [--all] | paths close <role> <domain>:<role> | audit [--tail N] [--verify]
  read-only views of the domain gateway, run on the gateway node (see the header of this file)`)

const dir = path.join(dataRoot(), 'gateway')
const [cmd = 'status', ...rest] = process.argv.slice(2)
const flag = (name: string) => {
  const i = rest.indexOf(name)
  return i >= 0 ? rest[i + 1] : undefined
}
const when = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '-')
const die = (m: string): never => {
  console.error(m)
  process.exit(1)
}

switch (cmd) {
  case 'key': {
    if (!fs.existsSync(certFile(dir))) die(`no domain key in ${dir}; cortex-install --gateway --domain <name>`)
    console.log(pinOfCert(fs.readFileSync(certFile(dir))))
    break
  }
  case 'check': {
    try {
      const c = readConfig(dir)
      console.log(`gateway.json is valid: domain ${c.domain}, listening on ${c.listen.host}:${c.listen.port}, actions never accepted`)
      for (const p of c.peers) {
        const roles = exposedToDomain(c, p.domain)
        console.log(`  peer ${p.domain}${p.address ? ` at ${p.address}` : ' (it dials us)'}: ${roles.length ? `exposed ${roles.join(', ')}` : 'nothing exposed'}`)
      }
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
    break
  }
  case 'status': {
    const s = readGatewayStatus(dir)
    if (!s) die(`the gateway is not running here (no fresh ${path.join(dir, 'status.json')}); it runs in the mesh daemon of a node with intent gateway`)
    console.log(`gateway ${s!.domain} on :${s!.port}  pin ${s!.pin}`)
    for (const p of s!.peers) console.log(`  ${p.linked ? 'linked    ' : 'not linked'} ${p.domain}${p.address ? ` (${p.address})` : ''}`)
    console.log(`  return paths open: ${s!.paths}; mailbox held: ${s!.mailbox}`)
    if (s!.banned.length) console.log(`  banned sources: ${s!.banned.join(', ')}`)
    if (s!.audit) console.log(`  audit: ${s!.audit.lines} lines, ${s!.audit.ok ? 'chain verified' : `CHAIN BROKEN at ${s!.audit.broken}`}`)
    break
  }
  case 'paths': {
    if (rest[0] === 'close') {
      const [role, ext] = [rest[1], rest[2]]
      const m = ext ? /^([^:]+):(.+)$/.exec(ext) : null
      if (!role || !m) die('usage: cortex-gate paths close <internal role> <domain>:<external role>')
      if (!readGatewayStatus(dir)) die('the gateway is not running here; it closes the path itself, so start it first')
      const control = path.join(dir, 'control')
      fs.mkdirSync(control, { recursive: true })
      const by = process.env.USER ?? 'operator'
      fs.writeFileSync(path.join(control, `${Date.now()}-${process.pid}.json`), JSON.stringify({ op: 'close-path', role, domain: m![1], from: m![2], by }))
      const db = new Database(path.join(dir, 'gateway.sqlite'), { readonly: true })
      const open = () => !!db.prepare('SELECT 1 FROM paths WHERE internal_role = ? AND ext_domain = ? AND ext_role = ? AND closed_at IS NULL').get(role, m![1], m![2])
      for (let i = 0; i < 20 && open(); i++) await new Promise((r) => setTimeout(r, 250))
      if (open()) die(`asked the gateway to close ${role} <- ${ext}; it is still open after 5 s (is the gateway pumping? see the mesh daemon log)`)
      console.log(`closed ${role} <- ${ext} (audited)`)
      break
    }
    const file = path.join(dir, 'gateway.sqlite')
    if (!fs.existsSync(file)) die(`no gateway state in ${dir}`)
    const db = new Database(file, { readonly: true })
    const all = rest.includes('--all')
    const rows = db.prepare(`SELECT * FROM paths ${all ? '' : 'WHERE closed_at IS NULL'} ORDER BY last_used DESC`).all() as {
      internal_role: string; ext_domain: string; ext_role: string; opened_at: number; last_used: number; opened_by: string; closed_at: number | null; closed_why: string | null
    }[]
    if (!rows.length) console.log(all ? '(no return paths, ever)' : '(no open return paths)')
    for (const r of rows) {
      const state = r.closed_at ? `closed ${when(r.closed_at)} (${r.closed_why})` : 'open'
      console.log(`  ${r.internal_role} <- ${r.ext_domain}:${r.ext_role}  ${state}; opened ${when(r.opened_at)} by ${r.opened_by}, last used ${when(r.last_used)}`)
    }
    break
  }
  case 'audit': {
    if (rest.includes('--verify')) {
      const v = verifyAudit(dir)
      if (!v.ok) die(`audit chain BROKEN at line ${v.line}: ${v.why}`)
      else console.log(`audit chain verified: ${v.lines} lines`)
      break
    }
    const n = Number(flag('--tail') ?? 20)
    if (!Number.isInteger(n) || n <= 0) die('--tail takes a positive number')
    for (const l of readAudit(dir).slice(-n)) {
      const who = l.principal ? ` ${l.principal}` : ''
      console.log(`${when(l.at)}  #${l.seq}  ${l.dir.padEnd(4)} ${l.decision.padEnd(9)} ${l.peer}${who}${l.kind ? ` (${l.kind})` : ''}: ${l.rule}`)
    }
    break
  }
  default:
    die('usage: cortex-gate status | key | check | paths [--all] | paths close <role> <domain>:<role> | audit [--tail N] [--verify]')
}
