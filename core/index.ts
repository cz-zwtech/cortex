/**
 * Cortex V2 core — the entry point.
 *
 * What a naked scaffold provides, per the design task: self-description,
 * the module lifecycle, the contribution points, and health. Nothing else.
 * "Slash doesn't have to do things, just show it works."
 *
 * The V1 defect this file exists to avoid: `server/index.ts` there statically
 * imported all 16 routers at module scope and mounted every one
 * unconditionally, so importing one route transitively loaded ~4,500 lines of
 * subsystem. Here core imports NO module code. Modules are found, and only then
 * imported — which is what makes a zero-module boot real rather than nominal.
 */

import express from 'express'
import path from 'node:path'
import { EventBus } from './events.js'
import { Storage } from './storage.js'
import { Lifecycle } from './lifecycle.js'
import { CORE_VERSION, CONTRACT_VERSION, SUPPORTS } from './compat.js'
import { buildStatus } from './status.js'
import { hostPaths } from './paths.js'

const env = process.env

// Every path from core/paths.ts, as the CLIs and the mesh daemon take them. The host
// used to read its own home variable (in places the CHECKOUT) where they read the state
// dir's, so a node that set one and not the other ran its host on different stores.
const { modulesDir, dataRoot, dbPath } = hostPaths()
const port = Number(env.CKN_PORT ?? 3011)
const bind = env.CKN_BIND ?? '127.0.0.1'

const log = (msg: string) => console.log(msg)

const events = new EventBus()
const storage = new Storage(dbPath)
const lifecycle = new Lifecycle({ modulesDir, dataRoot, dbPath, events, storage, log, host: true })

const app = express()
app.use(express.json())

// The only routes core owns. Everything else is contributed by a module.
app.get('/api/health', (_req, res) => {
  res.json(buildStatus({ lifecycle, events, storage, modulesDir }))
})

app.get('/api/version', (_req, res) => {
  res.json({ core: CORE_VERSION, contract: CONTRACT_VERSION, supports: SUPPORTS })
})

const main = async () => {
  log(`[core] cortex ${CORE_VERSION} (contract ${CONTRACT_VERSION})`)
  log(`[core] modules dir: ${modulesDir}`)

  const { statuses } = await lifecycle.run()

  const started = statuses.filter((s) => s.state === 'started')
  if (started.length === 0) {
    log('[core] no modules installed — running as a bare scaffold')
  } else {
    log(`[core] started ${started.length} module(s): ${started.map((s) => s.name).join(', ')}`)
  }
  for (const s of statuses.filter((s) => s.state !== 'started')) {
    log(`[core] ${s.name}: ${s.state} — ${s.reason}`)
  }

  // Module-contributed routes mount AFTER core's own, so a module cannot
  // shadow /api/health and make a broken system look healthy.
  for (const mod of lifecycle.started) {
    for (const route of mod.manifest.routes) {
      try {
        const handlerMod = await import(
          (await import('./paths.js')).pathToFile(path.join(mod.dir, route.handler))
        )
        const router = handlerMod.default ?? handlerMod.router
        if (router) app.use(route.mount, router)
      } catch (err) {
        log(`[core] ${mod.manifest.name}: route ${route.mount} failed to mount: ${err}`)
      }
    }
  }

  const server = app.listen(port, bind, () => {
    log(`[core] listening on http://${bind}:${port}`)
  })
  // Core's own status port is a convenience: a clash (the home machine has a container on 3011) must not take
  // down the modules this host runs. Say so and keep running; CKN_PORT moves it.
  server.on('error', (err: NodeJS.ErrnoException) => log(`[core] status port ${bind}:${port} unavailable (${err.code ?? err.message}); modules keep running. Set CKN_PORT to move it.`))

  const shutdown = async (signal: string) => {
    log(`[core] ${signal} — shutting down`)
    server.close()
    await lifecycle.stopAll()
    storage.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('[core] fatal:', err)
  process.exit(1)
})
