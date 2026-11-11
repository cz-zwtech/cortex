/**
 * The modules a person took out with `cortex-setup module remove`. The install links every bundled
 * module and the updater runs the install, so without this record a removed module came back on
 * the next update.
 */
import fs from 'node:fs'
import path from 'node:path'

import { stateDir } from './paths.js'

const file = () => path.join(stateDir(), 'modules.json')

export const removedModules = (): string[] => {
  try {
    const removed = (JSON.parse(fs.readFileSync(file(), 'utf-8')) as { removed?: unknown }).removed
    return Array.isArray(removed) ? removed.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

export const setRemoved = (name: string, removed: boolean): void => {
  const names = new Set(removedModules())
  if (removed) names.add(name)
  else names.delete(name)
  fs.mkdirSync(stateDir(), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify({ removed: [...names].sort() }, null, 2) + '\n')
}
