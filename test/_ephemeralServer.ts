/**
 * FR #154 part (b) — the ONE way a test spawns server/index.ts. Always ephemeral:
 * CKN_FORBID_DEFAULT_DB + CKN_NO_HOOK_REGISTER (registration suppressed even before
 * the canonical auto-detect), plus an isolated temp HOME + graph DB + config dir and
 * no private-mind / mesh / embeddings. No test can forget the flags and hijack the
 * real ~/.claude / home pointer the way the engagement-sync boot did. Underscore-
 * prefixed so a test glob does not pick it up as a test.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export interface EphemeralServer {
  proc: ChildProcess
  baseUrl: string
  home: string
  dbPath: string
  /** The exact env the server was booted with — reuse it to spawn a matching
   *  ckn-sync / CLI subprocess against the same ephemeral home + graph DB. */
  env: Record<string, string>
  stop: () => void
}

export const spawnEphemeralServer = async (opts: {
  port: number
  home?: string
  dbPath?: string
  extraEnv?: Record<string, string>
}): Promise<EphemeralServer> => {
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-ephem-home-'))
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-ephem-db-'))
  const dbPath = opts.dbPath ?? path.join(dbDir, 'graph.sqlite')
  const cfg = path.join(home, '.config', 'ckn')
  fs.mkdirSync(cfg, { recursive: true })
  const baseUrl = `http://127.0.0.1:${opts.port}`

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    CKN_HOME: home,
    CKN_CONFIG_DIR: cfg,
    CKN_GRAPH_DB_PATH: dbPath,
    CKN_PORT: String(opts.port),
    CKN_BIND: '127.0.0.1',
    CKN_SERVER_URL: baseUrl,
    CKN_FORBID_DEFAULT_DB: '1',
    CKN_NO_HOOK_REGISTER: '1',
    CKN_PRIVATE_MIND: 'off',
    CKN_EMBEDDINGS: 'off',
    CKN_MESH_PEERS: '',
    CKN_MESH_TOKEN: '',
    ...(opts.extraEnv ?? {}),
  }

  const proc = spawn('node_modules/.bin/tsx', ['server/index.ts'], {
    cwd: repoRoot,
    env,
    stdio: 'ignore',
    detached: true,
  })

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${baseUrl}/api/home`)).ok) break
    } catch {
      /* not up yet */
    }
    await sleep(150)
  }

  const stop = () => {
    try {
      if (proc.pid) process.kill(-proc.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(dbDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }

  return { proc, baseUrl, home, dbPath, env, stop }
}
