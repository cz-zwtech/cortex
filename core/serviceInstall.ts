/**
 * `cortex-install --service`: a send-only node for a service account (18
 * Oct 2026: on home the `svc` account runs the telegram module and the
 * tracker timers).
 *
 * Comms data is per Linux user, so a service cannot send through a human's
 * node; it runs its own. It is lean on purpose: comms and mesh only, no Claude
 * Code hooks (headless `claude -p` runs as that user stay clean and off the
 * roster), no memory, bound to loopback, peered to the human node on the same
 * host, and kept up by a systemd user unit rather than by sessions.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SERVICE_MODULES = ['comms']

export type ServiceOpts = { alias: string; port: number; peer: string; role: string; modules: string[] }

const value = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export const serviceOpts = (argv: string[], hostname = os.hostname()): ServiceOpts | { error: string } => {
  const host = hostname.split('.')[0]!.toLowerCase()
  const port = Number(value(argv, '--port') ?? 3022)
  const opts = {
    alias: value(argv, '--alias') ?? `${host}-svc`,
    port,
    peer: value(argv, '--peer') ?? '127.0.0.1:3021',
    role: value(argv, '--role') ?? 'service',
    // Host-only modules this service runs as well, e.g. --with telegram.
    modules: [...SERVICE_MODULES, ...(value(argv, '--with') ?? '').split(',').map((m) => m.trim()).filter(Boolean)],
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { error: `--port must be a port number (got ${value(argv, '--port')})` }
  // The node and role name grammars of comms addressing (address.ts), aliases kept lowercase.
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(opts.alias)) return { error: `--alias must be lowercase letters, digits, dots and dashes (got ${opts.alias})` }
  if (opts.modules.some((m) => !/^[a-z][a-z0-9-]*$/.test(m))) return { error: `--with takes module names, comma separated (got ${value(argv, '--with')})` }
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(opts.role)) return { error: `--role must start with a letter, then lowercase letters, digits and dashes (got ${opts.role})` }
  return opts
}

/**
 * This node's own id, written once. Without it the service user's node takes
 * the machine-id it inherited from V1, which on home is the human node's id.
 */
export const ensureNodeId = (stateDir: string, alias: string): { id: string; minted: boolean } => {
  const file = path.join(stateDir, 'node-id')
  try {
    const id = fs.readFileSync(file, 'utf-8').trim()
    if (id) return { id, minted: false }
  } catch {
    /* mint below */
  }
  const id = `${alias}-${crypto.randomBytes(3).toString('hex')}`
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(file, id + '\n', { flag: 'wx' })
  return { id, minted: true }
}

/** Refuse when the Claude config already carries Cortex hooks: a service account must have none. */
export const hookedSettings = (claudeDir: string): string | undefined => {
  const file = path.join(claudeDir, 'settings.json')
  try {
    return fs.readFileSync(file, 'utf-8').includes('cortex-hook.ts') ? file : undefined
  } catch {
    return undefined
  }
}
