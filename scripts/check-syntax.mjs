#!/usr/bin/env node
/**
 * Syntax check via esbuild's parser.
 *
 * tsc --noEmit catches type errors but is tolerant of malformed string
 * literals — see the hookRegistrar.ts:191 bug that shipped in 0.13.2.
 * esbuild's parser is strict and matches what the runtime actually uses.
 *
 * Walks bin/ + server/ recursively, runs esbuild parse on every .ts +
 * .tsx file, exits non-zero on any failure. Cheap (~1s for the whole
 * tree) — wire into pre-commit + CI.
 */
import { transform } from 'esbuild'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(__dirname)

const TARGET_DIRS = ['bin', 'server', 'src']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.cache', 'build'])

const walk = async (dir) => {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await walk(full)))
    } else if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx'))) {
      out.push(full)
    }
  }
  return out
}

const main = async () => {
  const files = []
  for (const d of TARGET_DIRS) {
    files.push(...(await walk(join(ROOT, d))))
  }
  let failed = 0
  for (const file of files) {
    const src = await readFile(file, 'utf-8')
    try {
      await transform(src, { loader: file.endsWith('.tsx') ? 'tsx' : 'ts' })
    } catch (e) {
      failed++
      const rel = file.slice(ROOT.length + 1)
      console.error(`✗ ${rel}`)
      const msgs = e.errors ?? []
      for (const m of msgs) {
        const loc = m.location ? `${m.location.line}:${m.location.column}` : '?'
        console.error(`    ${loc}  ${m.text}`)
      }
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} file${failed === 1 ? '' : 's'} failed syntax check`)
    process.exit(1)
  }
  console.log(`✓ syntax check passed: ${files.length} files`)
}

main().catch((e) => {
  console.error('check-syntax fatal:', e?.message ?? e)
  process.exit(2)
})
