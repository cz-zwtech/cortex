import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { ensureDomainKey } from '../server/keys.js'
import { startGateway, type Gateway } from '../server/gateway.js'
import { readGatewayStatus } from '../server/status.js'

const dirs: string[] = []
const running: Gateway[] = []
after(async () => {
  for (const g of running) await g.close()
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }))
})

const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => ok(p))
    })
  })

const until = async (what: string, fn: () => boolean, ms = 8_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(`timed out waiting for: ${what}`)
}

/** A gateway's data dir with its key; returns the dir and its pin. */
const domain = (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gw-${name}-`))
  dirs.push(dir)
  return { dir, pin: ensureDomainKey(dir, name).pin }
}
const configure = (dir: string, c: Record<string, unknown>) => fs.writeFileSync(path.join(dir, 'gateway.json'), JSON.stringify(c))

test('two gateways link over TLS when each holds the other\'s pinned key; the link carries frames both ways', async () => {
  const e = domain('home')
  const f = domain('partner')
  const [ep, fp] = [await freePort(), await freePort()]
  configure(e.dir, { domain: 'home', listen: { host: '127.0.0.1', port: ep }, peers: [{ domain: 'partner', pin: f.pin }] })
  configure(f.dir, { domain: 'partner', listen: { host: '127.0.0.1', port: fp }, peers: [{ domain: 'home', address: `127.0.0.1:${ep}`, pin: e.pin }] })
  const E = await startGateway({ dir: e.dir, log: () => {} })
  const F = await startGateway({ dir: f.dir, log: () => {} })
  running.push(E, F)
  await until('partner dials home and both see the link', () => E.links.linked('partner') && F.links.linked('home'))
  assert.equal(readGatewayStatus(e.dir)?.pin, e.pin)
  assert.ok(F.links.send('home', { t: 'ping', n: 1 }), 'an open link takes frames')
  assert.equal(F.links.send('nobody', { t: 'ping' }), false, 'no link, no send')
})

test('a gateway whose key is not pinned is refused, and banned after repeated failures', async () => {
  const e = domain('home')
  const x = domain('stranger')
  const [ep, xp] = [await freePort(), await freePort()]
  const refused: string[] = []
  configure(e.dir, { domain: 'home', listen: { host: '127.0.0.1', port: ep }, peers: [], limits: { banAfterFailures: 2, banMinutes: 1 } })
  // The stranger pins home's real key, so only home's check can refuse it.
  configure(x.dir, { domain: 'stranger', listen: { host: '127.0.0.1', port: xp }, peers: [{ domain: 'home', address: `127.0.0.1:${ep}`, pin: domain('home2').pin.replace(/^./, 'A') }] })
  const E = await startGateway({ dir: e.dir, log: (m) => refused.push(m) })
  running.push(E)
  // Point the stranger at home with home's actual pin, so the refusal is home's, by key.
  configure(x.dir, { domain: 'stranger', listen: { host: '127.0.0.1', port: xp }, peers: [{ domain: 'home', address: `127.0.0.1:${ep}`, pin: (await import('../server/keys.js')).pinOfCert(fs.readFileSync(path.join(e.dir, 'domain.crt'))) }] })
  const X = await startGateway({ dir: x.dir, log: () => {} })
  running.push(X)
  await until('home refuses the stranger by key', () => refused.some((m) => /is not a pinned peer/.test(m)))
  await until('and bans it after two failures', () => refused.some((m) => /banned for 1 min after 2 failures/.test(m)), 15_000)
  assert.equal(E.links.linked('stranger'), false)
  assert.equal(E.links.banned().length, 1)
})

test('a dialler checks the listener\'s key too: the wrong key behind the right address is not linked', async () => {
  const e = domain('home')
  const imposter = domain('imposter')
  const f = domain('partner')
  const ip = await freePort()
  // The imposter listens where home should be, and pins partner so the TLS handshake itself completes.
  configure(imposter.dir, { domain: 'imposter', listen: { host: '127.0.0.1', port: ip }, peers: [{ domain: 'partner', pin: f.pin }] })
  const I = await startGateway({ dir: imposter.dir, log: () => {} })
  const dials: string[] = []
  configure(f.dir, { domain: 'partner', listen: { host: '127.0.0.1', port: await freePort() }, peers: [{ domain: 'home', address: `127.0.0.1:${ip}`, pin: e.pin }] })
  const F = await startGateway({ dir: f.dir, log: (m) => dials.push(m) })
  running.push(I, F)
  await until('partner refuses the server key', () => dials.some((m) => /does not hold home's pinned key/.test(m)))
  assert.equal(F.links.linked('home'), false)
})
