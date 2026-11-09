/**
 * Module boundaries, for every module (2 Nov 2026): a module reaches another only through what
 * that module publishes. Capabilities, at run time: each one a module uses is in the providing
 * module's manifest, and that module is in the user's `requires` or `optional`. Code, where no
 * capabilities exist (the gateway runs inside comms' mesh daemon): only the other module's
 * server/api.ts, never its other files. Read from the source, so it holds on any checkout.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const modulesDir = path.join(import.meta.dirname, '..', 'modules')
const modules = fs.readdirSync(modulesDir).filter((m) => fs.existsSync(path.join(modulesDir, m, 'module.json')))
const manifest = (m: string) => JSON.parse(fs.readFileSync(path.join(modulesDir, m, 'module.json'), 'utf-8'))

const sources = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name)
        return e.isDirectory() ? sources(p) : /\.(ts|mjs|js)$/.test(e.name) ? [p] : []
      })
    : []
const shipped = (m: string) => ['server', 'bin'].flatMap((d) => sources(path.join(modulesDir, m, d)))
const imports = (file: string) => [...fs.readFileSync(file, 'utf-8').matchAll(/(?:from\s+|import\(\s*)['"`](\.[^'"`]+)['"`]/g)].map((x) => x[1]!)

test('no module imports another module\'s files, except that module\'s published server/api.ts', () => {
  const reach: string[] = []
  for (const m of modules)
    for (const file of shipped(m))
      for (const spec of imports(file)) {
        const target = path.relative(modulesDir, path.resolve(path.dirname(file), spec))
        if (target.startsWith('..') || target.startsWith(`${m}${path.sep}`)) continue
        if (/^[a-z-]+\/server\/api\.js$/.test(target)) continue
        reach.push(`${path.relative(modulesDir, file)} -> ${target}`)
      }
  assert.deepEqual(reach, [])
})

test('every capability a module uses is published by a module it declares', () => {
  const ids = new RegExp(`['"]((?:${modules.join('|')})\\.[a-zA-Z]+)['"]`, 'g')
  const wrong: string[] = []
  for (const m of modules) {
    const man = manifest(m)
    const declared = new Set<string>([...(man.requires ?? []), ...(man.optional ?? [])])
    for (const file of shipped(m))
      for (const x of fs.readFileSync(file, 'utf-8').matchAll(ids)) {
        const id = x[1]!
        if (/\.(sqlite|json|db|md|ts|js)$/.test(id)) continue // a file name, not a capability
        const owner = id.split('.')[0]!
        if (owner === m) continue
        if (!declared.has(owner)) wrong.push(`${m} uses ${id} but does not declare ${owner}`)
        else if (!(manifest(owner).provides ?? []).includes(id)) wrong.push(`${m} uses ${id}, which ${owner} does not publish`)
      }
  }
  assert.deepEqual([...new Set(wrong)], [])
})
