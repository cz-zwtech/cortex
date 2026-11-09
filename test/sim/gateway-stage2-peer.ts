/**
 * Stage 2 of the gateway bring-up, the peer half: a test peer domain on a
 * laptop outside the LAN (on a phone hotspot), dialling E's WAN address. The
 * home half is gateway-stage2-home.sh on node-a.
 *
 *   F  a peer gateway, domain lab-peer, dialling <WAN>:28417
 *   G  F's home node (lp-1 in lp-dev)
 *
 * Plain Node processes, so it runs on Windows as well as Linux, with nothing
 * shared with the laptop's own Cortex: all state lives under one root (the
 * temp dir unless --root), each process gets CKN_STATE_DIR there, and both
 * daemons bind loopback on ports of their own. Delete the root and it is gone.
 *
 * Usage (from a Cortex checkout at v2/main, after npm ci):
 *   npx tsx test/sim/gateway-stage2-peer.ts setup <WAN address> <E pin>   prints F's pin and E's gateway.json
 *   npx tsx test/sim/gateway-stage2-peer.ts check <tag>                   start F, run the peer checks
 *   npx tsx test/sim/gateway-stage2-peer.ts address <WAN address>         the WAN changed: point F at it
 *   npx tsx test/sim/gateway-stage2-peer.ts clean
 * Add --root <dir> to any of them to keep the state somewhere else.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..', '..')
const args = process.argv.slice(2)
const rootAt = args.indexOf('--root')
const ROOT = rootAt >= 0 ? path.resolve(args.splice(rootAt, 2)[1]!) : path.join(os.tmpdir(), 'cortex-stage2-peer')
const [cmd, a1, a2] = args

const F = { name: 'f', machine: 'stage2-f', port: 3121 }
const G = { name: 'g', machine: 'stage2-g', port: 3122 }
type Proc = typeof F
const stateDir = (p: Proc) => path.join(ROOT, p.name)
const meshDir = (p: Proc) => path.join(stateDir(p), 'data', 'mesh')
const gatewayDir = path.join(stateDir(F), 'data', 'gateway')
const pidFile = (p: Proc) => path.join(ROOT, `${p.name}.pid`)
const DEADLINE_S = 300

const env = (p: Proc, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  CKN_STATE_DIR: stateDir(p),
  CKN_MACHINE: p.machine,
  CKN_NODE_ALIAS: p.machine,
  CKN_MESH_PORT: String(p.port),
  CKN_MESH_BIND: '127.0.0.1',
  CKN_MODULES_DIR: path.join(REPO, 'modules'),
  ...extra,
})


const alive = (p: Proc): boolean => {
  try {
    process.kill(Number(fs.readFileSync(pidFile(p), 'utf-8')), 0)
    return true
  } catch {
    return false
  }
}

const startDaemon = (p: Proc, extra: Record<string, string> = {}) => {
  if (alive(p)) return
  const out = fs.openSync(path.join(ROOT, `${p.name}.log`), 'a')
  // One process, tsx as a loader: node_modules/.bin/tsx is a .cmd on Windows that spawn cannot run without a
  // shell, and tsx's own cli forks a child that a kill on Windows would leave running.
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'bin', 'cortex-mesh.ts'), 'serve'], {
    cwd: REPO,
    env: env(p, extra),
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
  child.unref()
  fs.writeFileSync(pidFile(p), String(child.pid))
}

const stopDaemon = (p: Proc) => {
  if (!alive(p)) return
  try {
    process.kill(Number(fs.readFileSync(pidFile(p), 'utf-8')))
  } catch {
    /* already gone */
  }
}

/** Code that runs as one of the nodes: its env is set before any Cortex module loads. */
const asNode = async <T>(p: Proc, fn: () => Promise<T>): Promise<T> => {
  const saved = { ...process.env }
  Object.assign(process.env, env(p))
  try {
    return await fn()
  } finally {
    process.env = saved
  }
}

const comms = async (p: Proc) => {
  const { Comms } = await import('../../modules/comms/server/comms.js')
  const { LocalIdentity } = await import('../../modules/comms/server/identity.js')
  const { MeshTransport } = await import('../../modules/comms/server/transport.js')
  const { MeshLog } = await import('../../modules/comms/server/mesh/log.js')
  const { meshView } = await import('../../modules/comms/server/mesh/view.js')
  return new Comms(new MeshTransport(new MeshLog(meshDir(p), p.machine)), new LocalIdentity(path.join(stateDir(p), 'id')), {
    liveMs: 600_000,
    settleMs: 0,
    sleep: async () => {},
    mesh: () => meshView(meshDir(p), p.machine),
  })
}

let pass = 0
let fail = 0
const ok = (what: string) => (console.log(`  PASS  ${what}`), pass++)
const no = (what: string) => (console.log(`  FAIL  ${what}`), fail++)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (what: string, secs: number, test: () => Promise<boolean>) => {
  for (let i = 0; i < secs; i++) {
    try {
      if (await test()) return ok(what)
    } catch {
      /* not yet */
    }
    await sleep(1000)
  }
  no(what)
}

const writeConfig = (wan: string, pin: string) => {
  const cfg = {
    domain: 'lab-peer',
    // Loopback: F only dials out. Nothing on the laptop listens to the network.
    listen: { host: '127.0.0.1', port: 28418 },
    peers: [{ domain: 'home', address: `${wan}:28417`, pin, expose: [{ human: 'node', role: 's2-pm', roles: ['lp-dev'] }] }],
  }
  fs.writeFileSync(path.join(gatewayDir, 'gateway.json'), `${JSON.stringify(cfg, null, 2)}\n`)
}

switch (cmd) {
  case 'setup': {
    const wan = a1
    const pin = a2
    if (!wan || !pin) throw new Error('usage: setup <WAN address> <E pin>')
    for (const p of [F, G]) stopDaemon(p)
    fs.rmSync(ROOT, { recursive: true, force: true })
    for (const p of [F, G]) fs.mkdirSync(meshDir(p), { recursive: true })
    fs.mkdirSync(gatewayDir, { recursive: true })
    const { ensureDomainKey } = await import('../../modules/gateway/server/keys.js')
    const fpin = ensureDomainKey(gatewayDir, 'lab-peer').pin
    writeConfig(wan, pin)
    fs.writeFileSync(path.join(meshDir(G), 'peers.json'), `${JSON.stringify({ peers: [`http://127.0.0.1:${F.port}`] })}\n`)
    startDaemon(G)
    await asNode(G, async () => {
      await (await comms(G)).join('lp-dev', { create: true, as: 'lp-1' })
    })
    console.log(`State in ${ROOT}; G is up, F does not dial E until check.

F's pin: ${fpin}

On E, gateway.json (pm writes it; nothing of E's is exposed but s2-dev to lab-peer's lp-dev,
as sent by this machine's user, which is who a message from here says sent it):

{ "domain": "home", "peers": [{ "domain": "lab-peer", "pin": "${fpin}",
  "expose": [{ "human": "${os.userInfo().username}", "role": "lp-dev", "roles": ["s2-dev"] }] }] }

Then run check with the same tag as the home half.`)
    break
  }
  case 'address': {
    if (!a1) throw new Error('usage: address <WAN address>')
    const cfg = JSON.parse(fs.readFileSync(path.join(gatewayDir, 'gateway.json'), 'utf-8'))
    writeConfig(a1, cfg.peers[0].pin)
    console.log(`F now dials ${a1}:28417 (it re-reads its config within seconds)`)
    break
  }
  case 'check': {
    const T = a1
    if (!T) throw new Error('usage: check <tag>, the same tag as the home half')
    startDaemon(G)
    startDaemon(F, { CKN_MESH_INTENT: 'gateway' })
    await asNode(G, async () => {
      const c = await comms(G)
      const inbox = async () => c.inbox('lp-1', { includeSeen: true })
      const has = async (text: string) => (await inbox()).some((x) => x.body.includes(text))
      console.log(`== link (run ${T}); up to ${DEADLINE_S} s, while E takes F's pin`)
      await waitFor('G sees home through F, linked, announcing s2-dev', DEADLINE_S, async () => {
        const e = c.meshView()?.external?.find((x) => x.domain === 'home')
        return !!e && e.linked && JSON.stringify(e.roles) === '["s2-dev"]'
      })
      console.log('== inbound at home: lab-peer -> s2-dev (the home half checks it arrived as data)')
      console.log(`    ${(await c.send('lp-1', 'home:s2-dev', `stage2 ${T}: hello dev`)).outcome}`)
      console.log('== refused: lab-peer -> s2-pm, not exposed')
      console.log(`    ${(await c.send('lp-1', 'home:s2-pm', `stage2 ${T}: not for you`)).outcome}`)
      await waitFor('lp-1 is told it was not delivered', 60, () => has(`It said: stage2 ${T}: not for you`))
      console.log('== outbound from home, and the reply by the return path')
      await waitFor('lp-1 has s2-pm\'s question', DEADLINE_S, () => has(`stage2 ${T}: status?`))
      const q = (await inbox()).find((x) => x.body.includes(`stage2 ${T}: status?`))
      if (q) console.log(`    ${(await c.reply('lp-1', q.id, `stage2 ${T}: green`)).outcome}`)
      console.log('== held at E: the home half sends a fake key, then "done"')
      await waitFor('the home half is done', DEADLINE_S, () => has(`stage2 ${T}: done`))
      if (await has('AKIA')) no('... and the fake key never crossed')
      else ok('... and the fake key never crossed')
      const i = await c.inbox('lp-1')
      c.markSeen('lp-1', i.map((x) => x.id))
      console.log('== READ: the home half reads hello; READ crosses E and F back to G')
      const { MeshLog } = await import('../../modules/comms/server/mesh/log.js')
      const log = new MeshLog(meshDir(G), G.machine)
      await waitFor('G\'s hello is READ at home', DEADLINE_S, async () => {
        const r = log.db.prepare('SELECT read_at FROM outbox WHERE subject = ?').get(`stage2 ${T}: hello dev`) as { read_at: number | null } | undefined
        return !!r?.read_at
      })
      log.close()
    })
    console.log(`\nstage 2 peer half: ${pass} passed, ${fail} failed`)
    process.exitCode = fail ? 1 : 0
    break
  }
  case 'clean':
    for (const p of [F, G]) stopDaemon(p)
    await sleep(1000)
    fs.rmSync(ROOT, { recursive: true, force: true })
    console.log(`stopped F and G, removed ${ROOT}`)
    break
  default:
    console.log(fs.readFileSync(import.meta.filename, 'utf-8').split('\n').slice(1, 21).join('\n'))
    process.exitCode = 2
}
