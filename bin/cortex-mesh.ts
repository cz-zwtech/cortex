#!/usr/bin/env tsx
/**
 * cortex-mesh: the mesh daemon and peers.
 *
 *   start [--wait]          start the daemon unless it runs (only when this node connects: listen on, or peers)
 *   stop                    stop it (and its systemd unit) and release everything
 *   pause | resume          around an update (core's updater runs them): stop a running daemon and remember it;
 *                           start it again only if it was running and the node still connects
 *   status                  running, port, node id, peers and their links
 *   serve                   run the daemon in the foreground (what start launches)
 *   listen on|off           whether other nodes may dial in here (the daemon opens its port); off by default
 *   peers add|remove <url>  e.g. peers add 192.0.2.10:3021; the daemon starts or stops to match
 *   peers [list]
 *   forget <node|alias>     drop a node that is gone for good, on every node (it is heard again if it comes back)
 *   leave                   this node is going away for good: tell every node to forget it, then stop
 *   id                      this machine's node id
 *   unit                    print a systemd user unit for an always-on machine
 *   aliases install|remove  "cortex" (start + status) and "cortex-off" in ~/.bashrc
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { discover } from '../core/discover.js'
import { machineId } from '../core/machineId.js'
import { dataRoot, meshDir, modulesDir, runScript, stateDir } from '../core/paths.js'
import { isRunning, meshPort, readStatus, start, stop, unitText } from '../modules/comms/server/mesh/control.js'
import { serve } from '../modules/comms/server/mesh/daemon.js'
import { MeshLog, registerDeclaredKinds } from '../modules/comms/server/mesh/log.js'
import type { Accept } from '../modules/comms/server/mesh/router.js'
import type { Intent } from '../modules/comms/server/mesh/nodes.js'
import { acceptRouted, deliverFiles, localRoles, notifySender, unseenNotices } from '../modules/comms/server/meshBridge.js'
import { scanForSecrets } from '../core/secrets.js'
import { gateFile } from '../modules/comms/server/mesh/files.js'
import { addPeer, normalisePeer, readPeers, removePeer } from '../modules/comms/server/mesh/peers.js'
import { effectiveNodeConfig, nodeConfigFile, readNodeConfig, writeNodeConfig } from '../modules/comms/server/mesh/nodeConfig.js'
import { applyConnect, connects, listens, migrateConnect } from '../modules/comms/server/mesh/connect.js'
import { exitOnHelp } from '../core/help.js'

exitOnHelp(`usage: cortex-mesh <command>
  start [--wait] | stop | pause | resume | status | serve
  listen on|off               whether other nodes may dial in here (off by default)
  peers [list] | peers add|remove <host:port>
  config [alias|port|host <value>]
  forget <node|alias> | leave | retire-kind <kind> [--origin a,b] [--apply]
  id | unit | aliases install|remove
  (see the header of bin/cortex-mesh.ts)`)

const dir = meshDir()
const repo = path.resolve(import.meta.dirname, '..')
const [cmd, sub, arg] = process.argv.slice(2)
const die = (m: string): never => {
  console.error(`cortex-mesh: ${m}`)
  process.exit(1)
}

const BEGIN = '# >>> cortex (managed by cortex-mesh aliases) >>>'
const END = '# <<< cortex (managed by cortex-mesh aliases) <<<'
const rcFiles = () => ['.bashrc', '.zshrc'].map((f) => path.join(os.homedir(), f)).filter((f) => fs.existsSync(f))
const stripBlock = (text: string) => text.replace(new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`, 'g'), '\n')

const printStatus = () => {
  const s = readStatus(dir)
  console.log(`node:    ${machineId()}${s?.alias ? ` (alias ${s.alias})` : ''}${s?.intent && s.intent !== 'node' ? `, ${s.intent}` : ''}`)
  const listen = listens(dir)
  const unset = readNodeConfig(dir).listen === undefined
  console.log(`connect: ${listen ? 'listens' : 'does not listen'}${unset ? ' (not set yet: as this node did before; the next start or install writes it)' : ''}; ${readPeers(dir).length} peer(s)${connects(dir) ? '' : ' (local-only: no daemon)'}`)
  console.log(`daemon:  ${isRunning(dir) ? `running (pid ${s?.pid}, ${s?.port && listen ? `port ${s.port}` : 'no open port'})` : 'not running'}`)
  console.log(`roles:   ${s?.roles?.length ? s.roles.join(', ') : 'none yet (unvalidated: a node exchanges records once it has a role)'}`)
  const peers = readPeers(dir)
  console.log(`configured: ${peers.length ? peers.join(', ') : 'none'}`)
  const links = s?.links ?? []
  if (!links.length) console.log('links:   none (sessions here still talk through the local log)')
  for (const l of links) {
    const state = !l.live ? 'down   ' : l.ready ? 'live   ' : 'waiting'
    const who = l.node ?? '(handshaking)'
    const how = l.direction === 'out' ? `dialed ${l.url}` : 'called in'
    const what = l.intent && l.intent !== 'node' ? `, ${l.intent}` : l.roles?.length ? `, roles ${l.roles.join(' ')}` : ', no roles yet'
    console.log(`  ${state} ${who}  (${how}${what})`)
  }
  for (const d of s?.dials ?? []) {
    const next = d.nextAttemptAt ? `; next try in ${Math.max(0, Math.round((d.nextAttemptAt - Date.now()) / 1000))} s` : ''
    console.log(`  not linked ${d.url}: ${d.lastError ? `last dial failed: ${d.lastError}` : 'dialing'}${next}`)
  }
  const others = (s?.nodes ?? []).filter((n) => !n.linked)
  if (others.length) {
    console.log('known, not linked:')
    for (const n of others) {
      const via = n.route ? `route via ${n.route.nextHop}, ${n.route.hops} hops` : 'UNREACHABLE: its roles are unavailable'
      console.log(`  ${n.alias ? `${n.alias} = ` : ''}${n.node}  (${n.source}${n.intent !== 'node' ? `, ${n.intent}` : ''}${n.roles.length ? `, roles ${n.roles.join(' ')}` : ''}; ${via})`)
    }
  }
}

/** Addresses to advertise when this node is reached through a port mapping (CKN_MESH_ADVERTISE=host:port,...). */
const advertised = (): string[] | undefined => {
  const raw = process.env.CKN_MESH_ADVERTISE?.trim()
  return raw ? raw.split(',').map((a) => normalisePeer(a.trim())) : undefined
}

/** The gateway module, when this node is a gateway; it must be installed beside mesh. */
const startGatewayHere = async (log: MeshLog, routes: () => Map<string, unknown>) => {
  const mod = path.join(modulesDir(), 'gateway', 'server', 'gateway.ts')
  if (!fs.existsSync(mod)) throw new Error(`intent is gateway but the gateway module is not installed (${mod}); cortex-install --gateway`)
  const { startGateway } = (await import(mod)) as typeof import('../modules/gateway/server/gateway.js')
  return startGateway({ dir: path.join(dataRoot(), 'gateway'), mesh: { log, reachable: () => new Set(routes().keys()) } })
}

switch (cmd) {
  case 'serve': {
    const node = machineId()
    const conf = effectiveNodeConfig(dir)
    const intent = (conf.intent ?? 'node') as Intent
    if (!['node', 'relay', 'gateway'].includes(intent)) die(`CKN_MESH_INTENT must be node, relay or gateway (got ${intent})`)
    // Record kinds that modules flood, with their policies: declared in manifests, since the daemon hosts no modules.
    const found = await discover(modulesDir())
    for (const why of registerDeclaredKinds(found.found.map((m) => ({ module: m.manifest.name, kinds: m.manifest.meshKinds })))) console.error(`mesh: ${why}; ignored`)
    const bridge = new MeshLog(dir, node)
    const port = meshPort(dir)
    // On a gateway, its own mailboxes (gate:, gate-ctl:) are the gateway's to accept; every other one is comms'.
    let gateway: Awaited<ReturnType<typeof startGatewayHere>> | undefined
    const secretGate = gateFile((text) => scanForSecrets(text).map((f) => f.kind))
    const comms = acceptRouted(bridge)
    const accept: Accept = (address, body, from) =>
      address.startsWith('gate') ? (gateway?.accept(address, body, from) ?? { ok: false, reason: 'this node runs no gateway' }) : comms(address, body, from)
    const d = await serve(dir, node, port, {
      roles: localRoles(bridge),
      intent,
      // A node that does not listen opens no port and advertises nothing: it only dials its peers.
      // Unset (a node from before the setting, or started directly): listen, the side that never drops a node.
      listen: conf.listen !== false,
      addresses: conf.listen === false ? [] : advertised(),
      alias: conf.alias,
      host: conf.host,
      accept,
      notifySender: notifySender(bridge),
      // A file bound out of the domain gets the gateway's sanitizer (secret gate, deny list, audited); any other, the secret gate.
      files: {
        scan: (file, address) => (address.startsWith('gate') && gateway ? gateway.scanFile(file, address) : secretGate(file)),
        deliver: deliverFiles(bridge),
      },
    }).catch((err) =>
      die(`cannot serve on port ${port} (${err instanceof Error ? err.message : err}); set port in ${nodeConfigFile(dir)} or CKN_MESH_PORT to a free port`),
    )
    // A gateway node runs the gateway in this process, beside the mesh it serves (modules/gateway).
    // A delivered message that sits unseen because its target stopped listening: its sender hears it, once.
    const unseen = setInterval(() => {
      try {
        unseenNotices(bridge)
      } catch (err) {
        console.error(`comms: unseen notices skipped (${err instanceof Error ? err.message : String(err)})`)
      }
    }, 60_000)
    gateway = intent === 'gateway' ? await startGatewayHere(bridge, d.routes).catch((err) => die(`the gateway did not start: ${err instanceof Error ? err.message : String(err)}`)) : undefined
    const shut = async () => {
      clearInterval(unseen)
      await gateway?.close()
      await d.close()
      process.exit(0)
    }
    process.on('SIGTERM', shut)
    process.on('SIGINT', shut)
    break
  }
  case 'start': {
    migrateConnect(dir)
    if (!connects(dir)) {
      console.log('local-only: this node neither listens nor has peers, so there is no daemon to start (cortex-mesh listen on, or peers add <url>)')
      break
    }
    const r = await start(dir, { wait: true })
    if (r === 'failed') die(`the daemon did not come up; see ${path.join(dir, 'daemon.log')}`)
    console.log(r === 'already' ? 'mesh daemon already running' : 'mesh daemon started')
    break
  }
  case 'pause': {
    const marker = path.join(dir, 'paused-for-update')
    if (isRunning(dir)) {
      await stop(dir)
      fs.writeFileSync(marker, String(Date.now()))
      console.log('mesh daemon paused for the update')
    } else console.log('mesh daemon not running; nothing to pause')
    break
  }
  case 'resume': {
    const marker = path.join(dir, 'paused-for-update')
    if (!fs.existsSync(marker)) {
      console.log('mesh daemon was not paused; left as it is')
      break
    }
    fs.rmSync(marker, { force: true })
    if (!connects(dir)) {
      console.log('local-only now: not restarted')
      break
    }
    const r = await start(dir, { wait: true })
    if (r === 'failed') die(`the daemon did not come back; see ${path.join(dir, 'daemon.log')}`)
    console.log('mesh daemon resumed')
    break
  }
  case 'stop':
    console.log((await stop(dir)) === 'stopped' ? 'mesh daemon stopped; no Cortex process is left running' : 'mesh daemon was not running')
    break
  case undefined:
  case 'status':
    printStatus()
    break
  case 'peers':
    if (sub === 'add' && arg) {
      console.log(`peer added: ${addPeer(dir, arg)}`)
      console.log(`daemon: ${await applyConnect(dir)}`)
    } else if (sub === 'remove' && arg) {
      console.log(removePeer(dir, arg) ? 'peer removed' : 'no such peer')
      console.log(`daemon: ${await applyConnect(dir)}`)
    } else for (const p of readPeers(dir)) console.log(p)
    break
  case 'listen': {
    if (sub !== 'on' && sub !== 'off') die('usage: cortex-mesh listen on|off')
    writeNodeConfig(dir, { listen: sub === 'on' })
    // The port opens or closes only at start: restart a running daemon.
    await stop(dir)
    console.log(`listen ${sub}; daemon: ${await applyConnect(dir)}`)
    break
  }
  case 'config': {
    // cortex-mesh config [alias|port|host <value>]: this node's settings, read by every start.
    if (sub) {
      if (!['alias', 'port', 'host'].includes(sub) || !arg) die('usage: cortex-mesh config [alias|port|host <value>]')
      writeNodeConfig(dir, { [sub]: sub === 'port' ? Number(arg) : arg })
    }
    console.log(`${nodeConfigFile(dir)}: ${JSON.stringify(readNodeConfig(dir))}`)
    const eff = effectiveNodeConfig(dir)
    console.log(`effective: alias ${eff.alias ?? '(hostname)'}, port ${meshPort(dir)}, host ${eff.host ?? '0.0.0.0'}${sub ? '; restart the daemon to apply' : ''}`)
    break
  }
  case 'forget': {
    if (!sub) die('usage: cortex-mesh forget <node|alias>')
    const s = readStatus(dir)
    const n = (s?.nodes ?? []).find((x) => x.node === sub || x.alias === sub) ?? die(`no known node ${sub}; cortex-mesh status lists them`)
    if (n.linked || n.route) die(`${sub} is reachable now; forget only a node that is gone`)
    const log = new MeshLog(dir, machineId())
    try {
      log.forgetEverywhere(n.node)
    } finally {
      log.close()
    }
    console.log(`forgot ${n.alias ? `${n.alias} = ` : ''}${n.node} on every node${isRunning(dir) ? '' : '; it leaves this node\'s list when the daemon starts'}`)
    break
  }
  case 'leave': {
    const s = readStatus(dir)
    if (!isRunning(dir) || !(s?.links ?? []).some((l) => l.live && l.ready)) die('leave needs the daemon running and linked, to carry the notice out')
    const log = new MeshLog(dir, machineId())
    try {
      log.leave()
    } finally {
      log.close()
    }
    await new Promise((r) => setTimeout(r, 3_000)) // the daemon streams it out on its next tick
    await stop(dir)
    console.log('left the mesh: every node forgets this one as the notice reaches it; the daemon is stopped')
    break
  }
  case 'retire-kind': {
    // cortex-mesh retire-kind memory [--origin a,b] [--apply]: a dry run unless --apply,
    // and then only the origins named, after a backup of the log.
    const kind = sub ?? die('usage: cortex-mesh retire-kind <kind> [--origin a,b] [--apply]')
    const argv = process.argv.slice(2)
    const at = argv.indexOf('--origin')
    const origins = at >= 0 ? (argv[at + 1] ?? '').split(',').map((o) => o.trim()).filter(Boolean) : []
    const log = new MeshLog(dir, machineId())
    const counts = log.countKind(kind)
    const selected = origins.reduce((n, o) => n + (counts[o] ?? 0), 0)
    console.log(`records of kind "${kind}" in ${dir}:`)
    for (const [o, n] of Object.entries(counts)) console.log(`  ${o}: ${n}${origins.includes(o) ? '  (selected)' : ''}`)
    if (!Object.keys(counts).length) console.log('  none')
    console.log(`selected (kind "${kind}" from ${origins.length ? origins.join(', ') : 'no origin: name them with --origin'}): ${selected}`)
    if (!argv.includes('--apply')) {
      console.log('dry run: nothing changed (--apply to purge the selected records, after a backup)')
      log.close()
      break
    }
    if (!selected) {
      console.log('nothing selected; nothing changed')
      log.close()
      break
    }
    const backup = path.join(stateDir(), 'backups', `mesh-${new Date().toISOString().replace(/[:.]/g, '-')}-before-retire-${kind}.sqlite`)
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    try {
      await log.db.backup(backup)
    } catch (err) {
      log.close()
      die(`backup failed, nothing purged: ${(err as Error).message}`)
    }
    console.log(`backup: ${backup}`)
    console.log(`purged ${log.purgeKind(kind, origins)} record(s)`)
    log.close()
    break
  }
  case 'id':
    console.log(machineId())
    break
  case 'unit':
    process.stdout.write(unitText())
    break
  case 'aliases': {
    const block = [
      BEGIN,
      `cortex() { ${runScript(repo, 'cortex-mesh.ts')} start && ${runScript(repo, 'cortex-mesh.ts')} status; }`,
      `cortex-off() { ${runScript(repo, 'cortex-mesh.ts')} stop; }`,
      END,
    ].join('\n')
    const files = rcFiles()
    if (!files.length) die('no ~/.bashrc or ~/.zshrc to add the aliases to')
    for (const f of files) {
      const cleaned = stripBlock(fs.readFileSync(f, 'utf-8')).replace(/\n+$/, '\n')
      fs.writeFileSync(f, sub === 'remove' ? cleaned : `${cleaned}\n${block}\n`)
    }
    console.log(sub === 'remove' ? `aliases removed from ${files.join(', ')}` : `aliases "cortex" and "cortex-off" added to ${files.join(', ')}; open a new shell`)
    break
  }
  default:
    die('usage: cortex-mesh start | stop | status | serve | peers add|remove <url> | forget <node|alias> | leave | config [alias|port|host <value>] | retire-kind <kind> [--origin a,b] [--apply] | id | unit | aliases install|remove')
}
