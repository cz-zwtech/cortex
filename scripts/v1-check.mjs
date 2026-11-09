#!/usr/bin/env node
// npm runs this as V2's preinstall. A V1 updater that pulls V2 runs `npm ci` next, so this is the
// one point where V2 can stop it and say why. Only node's own modules: by the time npm runs it,
// node_modules may already be half replaced.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

if (process.env.CI || process.env.CORTEX_SKIP_V1_CHECK === '1') process.exit(0)

const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf-8')
  } catch {
    return undefined
  }
}

const hasV1Hook = (file) => {
  const text = read(file)
  if (!text) return false
  try {
    return JSON.stringify(JSON.parse(text).hooks ?? {}).includes('ckn-')
  } catch {
    return false
  }
}

const v1Unit = () => {
  const r = spawnSync('systemctl', ['--user', 'cat', 'cortex.service'], { encoding: 'utf-8' })
  return r.status === 0 && /cortex-runner\.sh|\/bin\/ckn-/.test(r.stdout)
}

const pointsHere = () => {
  const home = read(path.join(os.homedir(), '.config', 'ckn', 'home'))?.trim()
  if (!home) return false
  try {
    return fs.realpathSync(home) === fs.realpathSync(root)
  } catch {
    return false
  }
}

const claude = path.join(os.homedir(), '.claude')
const traces = [
  hasV1Hook(path.join(claude, 'settings.json')) && 'a ckn- hook in ~/.claude/settings.json',
  hasV1Hook(path.join(claude, 'settings.local.json')) && 'a ckn- hook in ~/.claude/settings.local.json',
  v1Unit() && "V1's cortex.service is installed",
  pointsHere() && '~/.config/ckn/home names this checkout',
].filter(Boolean)

if (!traces.length) process.exit(0)

console.error(read(path.join(root, 'ATTENTION.md')) ?? 'Cortex V1 users: follow docs/migrating-from-v1.md before installing V2.')
console.error(`Found here: ${traces.join('; ')}.`)
process.exit(1)
