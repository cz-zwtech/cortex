/**
 * This machine's stable node id.
 *
 * CKN_MACHINE wins. Then <state>/node-id, V2's own, which a service install
 * writes: a second Linux user on a machine inherited V1's machine-id, the same
 * id as the first user's node, and two nodes with one id cannot both route.
 * Otherwise <state>/machine-id, which is where V1 keeps it, so a machine keeps
 * its name across the V1 to V2 move. Otherwise minted once
 * and written. Every V2 journal used to stamp 'local', so three synced machines
 * would all have claimed the same lineage; mesh and memory both stamp this.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { stateDir } from './paths.js'

export const machineId = (env: NodeJS.ProcessEnv = process.env): string => {
  if (env.CKN_MACHINE?.trim()) return env.CKN_MACHINE.trim()
  try {
    const own = fs.readFileSync(path.join(stateDir(), 'node-id'), 'utf-8').trim()
    if (own) return own
  } catch {
    /* none: fall back to the machine id */
  }
  const file = path.join(stateDir(), 'machine-id')
  try {
    const id = fs.readFileSync(file, 'utf-8').trim()
    if (id) return id
  } catch {
    /* mint below */
  }
  const id = `${os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${crypto.randomBytes(3).toString('hex')}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(file, id + '\n', { flag: 'wx' })
  } catch {
    /* another process minted first; its id wins */
  }
  return fs.readFileSync(file, 'utf-8').trim()
}
