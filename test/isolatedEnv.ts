/**
 * The environment for any test that spawns a Cortex binary.
 *
 * Every root a binary could reach is a fresh temp dir: HOME, the harness config,
 * the state dir, the memory roots, and the bus URL (unreachable). Spreading
 * process.env alone inherits the developer's real ~/.claude, and on 2026-10-13
 * a mutation run that removed one guard let a spawned dispatcher consume 269
 * real memory files. Isolation must not depend on the code under test.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const isolatedEnv = (extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; root: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-iso-'))
  const home = path.join(root, 'home')
  const claude = path.join(home, '.claude')
  const memory = path.join(root, 'memory', 'memory')
  for (const d of [claude, memory]) fs.mkdirSync(d, { recursive: true })
  // Inherited Cortex overrides point at the developer's setup (CKN_MODULES_DIR
  // from a cortex-test run, a mesh dir, a db path); a sandbox starts without them.
  const inherited = { ...process.env }
  for (const k of ['CKN_MODULES_DIR', 'CKN_MESH_DIR', 'CKN_DB_PATH', 'CKN_COMMS_TRANSPORT', 'CKN_MACHINE']) delete inherited[k]
  return {
    root,
    env: {
      ...inherited,
      HOME: home,
      CLAUDE_CONFIG_DIR: claude,
      CKN_STATE_DIR: path.join(root, 'state'),
      CKN_MEMORY_DIRS: memory,
      CKN_SERVER_URL: 'http://127.0.0.1:9',
      ...extra,
    },
  }
}
