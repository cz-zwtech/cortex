#!/usr/bin/env tsx
/**
 * ckn-mesh — manage the persisted non-secret mesh config (~/.config/ckn/mesh.json).
 * The fleet token is NOT managed here (stays in OpenBao via bao-run).
 *   ckn-mesh show
 *   ckn-mesh set --peer <url> [--peer <url> ...] [--node-id <id>] [--self <url>]
 *   ckn-mesh clear
 */
import { readMeshConfig, writeMeshConfig, meshConfigPath, type MeshConfigFile } from '../server/bus/meshConfig.js'
import fs from 'node:fs'

export function runMeshCli(argv: string[]): void {
  const cmd = argv[0] ?? 'show'
  if (cmd === 'show') {
    console.log(`config: ${meshConfigPath()}`)
    console.log(JSON.stringify(readMeshConfig(), null, 2))
    return
  }
  if (cmd === 'clear') {
    try { fs.rmSync(meshConfigPath()) } catch { /* absent */ }
    console.log('mesh.json cleared')
    return
  }
  if (cmd === 'set') {
    const patch: MeshConfigFile = {}
    const peers: string[] = []
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]
      if (a === '--peer') peers.push(String(argv[++i]))
      else if (a === '--node-id') patch.nodeId = String(argv[++i])
      else if (a === '--self') patch.self = String(argv[++i])
    }
    if (peers.length) patch.peers = peers
    writeMeshConfig(patch)
    console.log(`updated ${meshConfigPath()}:`)
    console.log(JSON.stringify(readMeshConfig(), null, 2))
    return
  }
  console.error(`unknown command: ${cmd}`)
  process.exitCode = 1
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) runMeshCli(process.argv.slice(2))
