#!/usr/bin/env tsx
/**
 * cortex-public-check: is this tree ready to export as the public one? (public gate G10)
 *
 *   cortex-public-check [--list] [--loose] [--repo <dir>] [--export <dir>]
 *
 * Over the tracked files that would be exported (all but those under .public-exclude):
 *   names    every line matching .public-names, counted per file (--list prints them)
 *   memories a memory shipped outside tests: a front-matter block (---, key: value lines, ---)
 *            whose name: is a literal. Code that builds one (name: ${slug}) is not content. Cortex
 *            ships no memories: a fresh install starts with an empty store, so the allowed list
 *            below is empty on purpose.
 *   secrets  core's secret scanner; a finding outside a test is a failure, one in a test is listed
 *            by shape (tests hold made-up tokens on purpose)
 * Exits 1 on any name or any non-test secret. The two list files are never exported themselves.
 * --export copies the exportable files into <dir> (new or empty), and only when the tree passes:
 * the public tree is never made from one that fails.
 * --loose (always on with --export) also prints every case-insensitive substring hit for the raw
 * names in .public-loose, for a person to read before a push. It never changes the verdict: the
 * patterns decide, the loose list catches what a pattern's boundaries might miss.
 * Tests and sims are run separately (npm test, test/sim/*.sh).
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { scanForSecrets } from '../core/secrets.js'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const repo = path.resolve(arg('--repo') ?? path.join(import.meta.dirname, '..'))
const exportTo = arg('--export') && path.resolve(arg('--export')!)
if (exportTo && fs.existsSync(exportTo) && fs.readdirSync(exportTo).length) {
  console.log(`refused: ${exportTo} is not empty`)
  process.exit(2)
}
const lines = (f: string) =>
  fs.existsSync(path.join(repo, f)) ? fs.readFileSync(path.join(repo, f), 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : []
const exclude = lines('.public-exclude')
const names = lines('.public-names').map((p) => new RegExp(p))
const list = process.argv.includes('--list')
const loose = lines('.public-loose').map((n) => n.toLowerCase())
const showLoose = process.argv.includes('--loose') || !!exportTo

const files = execSync('git ls-files', { cwd: repo, encoding: 'utf-8' })
  .split('\n')
  .filter((f) => f && !exclude.some((x) => f === x || f.startsWith(x)))
// Memories that teach Claude how to use Cortex would be listed here. There are none.
const SHIPPED_MEMORIES: string[] = []
const NL = String.raw`(?:\n|\\n)`
const FRONT_MATTER = new RegExp(`---${NL}((?:[a-z_]+:[^\n\\\\]*${NL}){1,30})---`, 'g')
const shipsMemory = (text: string) =>
  [...text.matchAll(FRONT_MATTER)].some((m) => /(^|\\n|\n)name:\s*(?![^\n\\]*\$\{)\S/.test(m[1]!))
const isTest = (f: string) => /(^|\/)(test|tests)\//.test(f) || /\.test\.ts$/.test(f) || f.startsWith('examples/')

let nameHits = 0
const byFile: string[] = []
let secretFails = 0
const memories: string[] = []
const testSecrets: string[] = []
const looseHits: string[] = []
for (const f of files) {
  let text: string
  try {
    text = fs.readFileSync(path.join(repo, f), 'utf-8')
  } catch {
    continue
  }
  if (text.includes('\u0000')) continue
  const hits = text.split('\n').flatMap((l, i) => (names.some((r) => r.test(l)) ? [`${f}:${i + 1}: ${l.trim().slice(0, 140)}`] : []))
  if (!isTest(f) && !SHIPPED_MEMORIES.includes(f) && shipsMemory(text)) memories.push(f)
  if (showLoose)
    text.split('\n').forEach((l, i) => {
      if (loose.some((n) => l.toLowerCase().includes(n))) looseHits.push(`${f}:${i + 1}: ${l.trim().slice(0, 140)}`)
    })
  if (hits.length) {
    nameHits += hits.length
    byFile.push(`${String(hits.length).padStart(5)}  ${f}`)
    if (list) hits.forEach((h) => console.log(`  ${h}`))
  }
  for (const s of scanForSecrets(text, { explain: true })) {
    const line = `${f}: ${s.kind}${s.shape ? ` (${s.shape})` : ''}`
    if (isTest(f)) testSecrets.push(line)
    else {
      secretFails++
      console.log(`SECRET  ${line}`)
    }
  }
}
console.log(`files that would be exported: ${files.length} (excluded: ${exclude.join(', ')})`)
console.log(`names: ${nameHits} line(s) in ${byFile.length} file(s)${byFile.length ? '\n' + byFile.sort((a, b) => Number(b.trim().split(' ')[0]) - Number(a.trim().split(' ')[0])).slice(0, 40).join('\n') : ''}`)
console.log(`memories: ${memories.length} file(s) outside tests carry a memory${memories.length ? '\n' + memories.map((m) => `  ${m}`).join('\n') : ''}`)
console.log(`secrets outside tests: ${secretFails}; made-up tokens in tests: ${testSecrets.length} (shapes only, by --list)`)
if (list) testSecrets.forEach((t) => console.log(`  test  ${t}`))
if (showLoose) {
  console.log(`loose: ${looseHits.length} line(s) hold a raw name as a substring; read them before a push (not a failure)`)
  looseHits.forEach((h) => console.log(`  ${h}`))
}
if (nameHits || secretFails || memories.length) process.exit(1)
if (exportTo) {
  for (const f of files) {
    if (!fs.existsSync(path.join(repo, f))) continue
    fs.mkdirSync(path.dirname(path.join(exportTo, f)), { recursive: true })
    fs.copyFileSync(path.join(repo, f), path.join(exportTo, f))
  }
  console.log(`exported ${files.length} file(s) to ${exportTo}`)
}
