/**
 * The module boundary (2 Nov 2026): private mind is a module of its own that extends memory and
 * comms (the mesh is part of comms), and is built into neither. Read from the source, so it repeats on any
 * checkout. What runs (each module absent, disabled, removed after use, a dependency missing) is
 * test/sim/private-mind-boundary.sh.
 *
 * Every module's boundary in general: test/boundary.test.ts.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const modules = path.join(import.meta.dirname, '..', '..')
const self = path.join(modules, 'private-mind')
const EXTENDED = ['memory', 'comms']

const sources = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name)
        return e.isDirectory() ? sources(p) : /\.(ts|mjs|js)$/.test(e.name) ? [p] : []
      })
    : []
const shipped = (mod: string) => ['server', 'bin'].flatMap((d) => sources(path.join(modules, mod, d)))
const rel = (p: string) => path.relative(modules, p)
const manifest = (mod: string) => JSON.parse(fs.readFileSync(path.join(modules, mod, 'module.json'), 'utf-8'))

/** Every module specifier a file imports, statically or dynamically. */
const imports = (file: string): string[] =>
  [...fs.readFileSync(file, 'utf-8').matchAll(/(?:from\s+|import\(\s*)['"`]([^'"`]+)['"`]/g)].map((m) => m[1]!)


test('memory and comms do not import private mind or name it in code', () => {
  const found: string[] = []
  for (const mod of EXTENDED) {
    for (const file of shipped(mod)) {
      if (imports(file).some((s) => /private-mind/.test(s))) found.push(`${rel(file)}: imports private-mind`)
      fs.readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim()
          const comment = /^(\/\/|\*|\/\*)/.test(code)
          // V1's private-mind sync is a different thing: memory warns while its clone is attached.
          if (!comment && /private[-_ ]?mind|privateMind/i.test(code) && !/\bV1\b/.test(code)) found.push(`${rel(file)}:${i + 1}: ${code.slice(0, 120)}`)
        })
    }
    const m = manifest(mod)
    for (const key of ['requires', 'optional']) if ((m[key] ?? []).includes('private-mind')) found.push(`${mod}/module.json ${key}s private-mind`)
  }
  assert.deepEqual(found, [])
})

test('private mind imports no file of another module (core only)', () => {
  const reach: string[] = []
  for (const file of shipped('private-mind'))
    for (const spec of imports(file).filter((x) => x.startsWith('.'))) {
      const p = path.relative(modules, path.resolve(path.dirname(file), spec))
      if (!p.startsWith('private-mind/') && !p.startsWith('..')) reach.push(`${rel(file)} -> ${p}`)
    }
  assert.deepEqual(reach, [], 'F1-F3 (2 Nov) are fixed: intent and shape are capabilities, the scanner is core, the CLI starts the modules')
})

test('every capability private mind uses is published by a module it requires', () => {
  const used = new Set<string>()
  for (const file of shipped('private-mind'))
    for (const m of fs.readFileSync(file, 'utf-8').matchAll(/['"]((?:memory|comms)\.[a-zA-Z]+)['"]/g)) if (!/\.(sqlite|json|db)$/.test(m[1]!)) used.add(m[1]!) // not a file name
  const requires: string[] = manifest('private-mind').requires ?? []
  const unpublished = [...used].filter((id) => {
    const mod = id.split('.')[0]!
    return !requires.includes(mod) || !(manifest(mod).provides ?? []).includes(id)
  })
  assert.ok(used.size > 0)
  assert.deepEqual(unpublished, [], 'used but not in the providing module\'s manifest, or from a module not required')
})

test('private mind declares memory and comms as hard dependencies', () => {
  assert.deepEqual([...(manifest('private-mind').requires ?? [])].sort(), ['comms', 'memory'])
  assert.ok(fs.existsSync(path.join(self, 'test', 'boundary.test.ts')))
})
