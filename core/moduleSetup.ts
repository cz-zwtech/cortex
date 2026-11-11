/**
 * `cortex-setup module list | add | remove`: one command each way, with dependencies checked
 * against the manifests. A removal is recorded (modulePrefs.ts) so the install leaves it out.
 */
import fs from 'node:fs'
import path from 'node:path'

import { parseManifest, type Manifest } from './manifest.js'
import { removedModules, setRemoved } from './modulePrefs.js'
import { dataRoot, modulesDir } from './paths.js'

type Result = { ok: boolean; lines: string[] }

const manifestAt = (dir: string): Manifest | undefined => {
  try {
    const r = parseManifest(JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf-8')))
    return r.ok ? r.manifest : undefined
  } catch {
    return undefined
  }
}

const bundled = (repo: string): string[] =>
  fs.existsSync(path.join(repo, 'modules')) ? fs.readdirSync(path.join(repo, 'modules')).filter((n) => manifestAt(path.join(repo, 'modules', n))).sort() : []

const installed = (): Map<string, Manifest> =>
  new Map(
    (fs.existsSync(modulesDir()) ? fs.readdirSync(modulesDir()) : []).flatMap((n) => {
      const m = manifestAt(path.join(modulesDir(), n))
      return m ? [[n, m] as const] : []
    }),
  )

export const listModules = (repo: string): Result => {
  const have = installed()
  const removed = removedModules()
  const names = [...new Set([...bundled(repo), ...have.keys()])].sort()
  return {
    ok: true,
    lines: names.map((n) => {
      const m = have.get(n) ?? manifestAt(path.join(repo, 'modules', n))
      const state = have.has(n) ? 'installed' : removed.includes(n) ? 'removed (by you; module add brings it back)' : 'not installed'
      const extra = [m?.runs === 'host' ? 'host only' : '', m?.requires.length ? `requires ${m.requires.join(', ')}` : ''].filter(Boolean)
      return `${n.padEnd(14)} ${state}${extra.length ? `  (${extra.join('; ')})` : ''}`
    }),
  }
}

export const removeModule = (repo: string, name: string): Result => {
  const link = path.join(modulesDir(), name)
  const stat = fs.lstatSync(link, { throwIfNoEntry: false })
  if (!stat) return { ok: false, lines: [`${name} is not installed`] }
  if (!stat.isSymbolicLink()) return { ok: false, lines: [`${link} is a directory you placed there, not a bundled module's link: remove it yourself (rm -r)`] }
  const requiredBy = [...installed()].filter(([n, m]) => n !== name && m.requires.includes(name)).map(([n]) => n)
  if (requiredBy.length) return { ok: false, lines: [`refused: ${requiredBy.join(', ')} ${requiredBy.length > 1 ? 'require' : 'requires'} ${name}; remove ${requiredBy.length > 1 ? 'them' : 'it'} first`] }
  const host = installed().get(name)?.runs === 'host'
  fs.unlinkSync(link)
  setRemoved(name, true)
  const data = path.join(dataRoot(), name)
  return {
    ok: true,
    lines: [
      `${name} removed; installs and updates leave it out until \`cortex-setup module add ${name}\``,
      ...(host ? ['it runs in the Cortex host: restart cortex-host.service so it stops'] : []),
      ...(name === 'comms' ? ['if the mesh daemon runs, stop it: cortex-mesh stop'] : []),
      fs.existsSync(data) ? `its data stays in ${data}; to delete it, back up first (cortex-backup now), then remove the folder` : 'it has no data folder',
    ],
  }
}

export const addModule = (repo: string, name: string): Result => {
  const from = path.join(repo, 'modules', name)
  const m = manifestAt(from)
  if (!m) return { ok: false, lines: [`no module named ${name} in ${path.join(repo, 'modules')}`] }
  const have = installed()
  const missing = m.requires.filter((d) => !have.has(d))
  if (missing.length) return { ok: false, lines: [`refused: ${name} requires ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not installed; add ${missing.length > 1 ? 'them' : 'it'} first`] }
  const link = path.join(modulesDir(), name)
  if (!fs.lstatSync(link, { throwIfNoEntry: false })) {
    fs.mkdirSync(modulesDir(), { recursive: true })
    fs.symlinkSync(from, link, 'dir')
  }
  setRemoved(name, false)
  return { ok: true, lines: [`${name} added${m.runs === 'host' ? '; it runs in the Cortex host: restart cortex-host.service to start it' : ''}`] }
}
