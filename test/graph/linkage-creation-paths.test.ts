#!/usr/bin/env tsx
/**
 * §5/§6 creation-path coverage (memory→file linkage). The hollow join happened
 * because Path B (/cortex-snapshot) never told the model to stamp `mentions_files`.
 * This pins the Path-B template instruction so it can't silently regress.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const { COMMANDS } = await import('../../server/hookRegistrar.ts')

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── Path B: the /cortex-snapshot template instructs stamping mentions_files
{
  const snapshot = (COMMANDS as Array<{ name: string; body: string }>).find((c) => c.name === 'cortex-snapshot')
  assert.ok(snapshot, 'cortex-snapshot command exists')
  assert.match(snapshot!.body, /mentions_files/, 'Path-B template instructs mentions_files (the one-line fix)')
  assert.match(snapshot!.body, /file-knowledge graph|authoritative/, 'explains why it matters')
  ok('Path-B /cortex-snapshot template carries the mentions_files instruction')
}

// ── Path A: ckn-extract stamps mentions_files (incl. the VERBATIM tool-arg paths)
// Pinned at the source-contract level (like the Path-B template pin above) rather
// than executed — importing ckn-extract.ts runs its main() (SessionEnd hook), and
// the LLM extraction is API-billed. The two tokens below are the contract: a
// mentions_files frontmatter stamp, fed from evidence.filePaths (the paths seen in
// tool args). Removing either — the regression that hollowed Path B — fails here.
{
  const src = fs.readFileSync(new URL('../../bin/ckn-extract.ts', import.meta.url), 'utf8')
  assert.match(src, /fmLines\.push\(`mentions_files:/, 'Path-A stamps a mentions_files frontmatter line')
  assert.match(
    src,
    /const mentionsFiles =[\s\S]{0,120}evidence\.filePaths/,
    'mentions_files is built from the verbatim tool-arg file paths (evidence.filePaths)',
  )
  ok('Path-A /ckn-extract stamps mentions_files from tool-arg file paths')
}

console.log(`\nOK linkage-creation-paths.test.ts — ${passed} assertions passed`)
