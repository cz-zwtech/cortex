/**
 * This node's own settings, kept with its mesh data: <mesh>/node.json.
 *
 * The alias and port used to come only from the environment, which a shell
 * profile sets and a non-interactive start (ssh host 'cortex-mesh start', a
 * systemd unit) does not: home came up as its hostname and sends to home:* found
 * no such node. A file next to the data it describes is read the same way by
 * every start. The environment still wins, so a one-off override needs no edit.
 */
import fs from 'node:fs'
import path from 'node:path'

/** `intent`: a gateway node is one by its file, so a systemd start needs no CKN_MESH_INTENT. */
/** `listen`: other nodes may dial in (the daemon opens its port). Absent until set, or until the first migration. */
export type NodeConfig = { alias?: string; port?: number; host?: string; intent?: 'node' | 'relay' | 'gateway'; listen?: boolean }

export const nodeConfigFile = (dir: string) => path.join(dir, 'node.json')

export const readNodeConfig = (dir: string): NodeConfig => {
  try {
    const c = JSON.parse(fs.readFileSync(nodeConfigFile(dir), 'utf-8')) as NodeConfig
    return {
      alias: typeof c.alias === 'string' && c.alias.trim() ? c.alias.trim() : undefined,
      port: Number.isInteger(c.port) && c.port! > 0 ? c.port : undefined,
      host: typeof c.host === 'string' && c.host.trim() ? c.host.trim() : undefined,
      ...(c.intent === 'node' || c.intent === 'relay' || c.intent === 'gateway' ? { intent: c.intent } : {}),
      ...(typeof c.listen === 'boolean' ? { listen: c.listen } : {}),
    }
  } catch {
    return {}
  }
}

/** Merge into the file; an undefined field leaves what is there. */
export const writeNodeConfig = (dir: string, patch: NodeConfig): NodeConfig => {
  const next = { ...readNodeConfig(dir) }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as Record<string, unknown>)[k] = v
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(nodeConfigFile(dir), JSON.stringify(next, null, 2) + '\n')
  return next
}

/** What a start uses: the environment over the file. */
export const effectiveNodeConfig = (dir: string, env: NodeJS.ProcessEnv = process.env): NodeConfig => {
  const file = readNodeConfig(dir)
  return {
    alias: env.CKN_NODE_ALIAS?.trim() || file.alias,
    port: env.CKN_MESH_PORT ? Number(env.CKN_MESH_PORT) : file.port,
    host: env.CKN_MESH_BIND?.trim() || file.host,
    ...(env.CKN_MESH_INTENT?.trim() || file.intent ? { intent: (env.CKN_MESH_INTENT?.trim() as NodeConfig['intent']) || file.intent } : {}),
    ...(file.listen !== undefined ? { listen: file.listen } : {}),
  }
}
