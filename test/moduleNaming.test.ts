/**
 * The module naming rule (18 Oct 2026): a module stands on its own in
 * Cortex, so nothing it exposes carries a `zw` prefix, and its code holds no
 * machine-specific default. See docs/module-author-guide.md, section 10.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const MODULES = path.resolve(import.meta.dirname, '..', 'modules')
const modules = fs.readdirSync(MODULES).filter((m) => fs.existsSync(path.join(MODULES, m, 'module.json')))
const ZW = /zw/i
// The private names (machines, people, clients) live in .public-names, which never ships, so in the
// public tree this check has nothing to read and says so; modules that stay private are not held to it.
const listed = (f: string) => {
  const file = path.join(MODULES, '..', f)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : null
}
const PRIVATE = listed('.public-names')?.map((p) => new RegExp(p))
const privateModules = new Set((listed('.public-exclude') ?? []).flatMap((x) => x.match(/^modules\/([^/]+)\/$/)?.[1] ?? []))

/** Code without its comments: a comment may name a real machine, code may not. */
export const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')

const codeFiles = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name)
        return e.isDirectory() ? codeFiles(p) : /\.(ts|js|mjs)$/.test(e.name) ? [p] : []
      })
    : []

test('every module is checked', () => {
  assert.ok(modules.length >= 5, `found ${modules.join(', ')}`)
})

for (const m of modules) {
  test(`${m}: no zw in its name, folder, capabilities, events, commands or CLIs`, () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(MODULES, m, 'module.json'), 'utf-8')) as {
      name: string
      provides?: string[]
      publishes?: string[]
      commands?: { sub: string; file: string }[]
    }
    const exposed = [
      m,
      manifest.name,
      ...(manifest.provides ?? []),
      ...(manifest.publishes ?? []),
      ...(manifest.commands ?? []).flatMap((c) => [c.sub, c.file]),
      ...codeFiles(path.join(MODULES, m, 'bin')).map((f) => path.basename(f)),
    ]
    assert.deepEqual(exposed.filter((x) => ZW.test(x)), [])
  })

  test(`${m}: no machine, person or client name in server/ or bin/ code (comments excepted)`, { skip: !PRIVATE ? 'no .public-names in this tree' : privateModules.has(m) && 'a private module' }, () => {
    const hits = [...codeFiles(path.join(MODULES, m, 'server')), ...codeFiles(path.join(MODULES, m, 'bin'))].flatMap((f) =>
      stripComments(fs.readFileSync(f, 'utf-8'))
        .split('\n')
        .flatMap((line, i) => (PRIVATE!.some((r) => r.test(line)) ? [`${path.relative(MODULES, f)}:${i + 1}: ${line.trim()}`] : [])),
    )
    assert.deepEqual(hits, [])
  })
}

/** Shipped data a module carries (rulesets, defaults): its values may not brand it either. */
const dataFiles = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) return ['test', 'tests', 'node_modules', '__pycache__'].includes(e.name) ? [] : dataFiles(p)
        return /\.(ya?ml)$/.test(e.name) ? [p] : []
      })
    : []

for (const m of modules) {
  test(`${m}: no zw in the values of its shipped YAML (comments excepted)`, () => {
    const hits = dataFiles(path.join(MODULES, m)).flatMap((f) =>
      fs
        .readFileSync(f, 'utf-8')
        .split('\n')
        .map((l) => l.replace(/(^|\s)#.*$/, ''))
        .flatMap((line, i) => (ZW.test(line) ? [`${path.relative(MODULES, f)}:${i + 1}: ${line.trim()}`] : [])),
    )
    assert.deepEqual(hits, [])
  })
}

test('the comment stripper keeps code and drops comments, and leaves URLs alone', () => {
  assert.equal(stripComments("const a = 'x' // y\n/* z */ b").trim(), "const a = 'x' \n b")
  assert.equal(stripComments("fetch('http://x/y') // note"), "fetch('http://x/y') ")
})
