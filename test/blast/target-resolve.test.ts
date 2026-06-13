#!/usr/bin/env tsx
/**
 * Unit test for the pure symbol-matching core of bin/_blast-target.ts.
 * `matchSymbol` takes an INJECTED symbol list (no I/O) so file/symbol/
 * Class.method/ambiguity/not-found are all exercised deterministically.
 *
 * Run: npx tsx test/blast/target-resolve.test.ts
 */
import assert from 'node:assert/strict'
import { matchSymbol } from '../../bin/_blast-target.js'
import type { SymbolRow } from '../../server/graph/_rows.js'

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// Minimal SymbolRow factory — only the fields matchSymbol reads matter.
const sym = (over: Partial<SymbolRow> & { id: string; name: string; file: string }): SymbolRow => ({
  symbolKind: 'function',
  repo: 'cortex',
  lang: 'ts',
  line: 1,
  signature: '',
  base: 1,
  stickiness: 0,
  centrality: 0,
  lastSeen: 0,
  pinned: false,
  groundTruthValid: true,
  machine: 'M',
  root: '',
  ...over,
})

const symbols: SymbolRow[] = [
  sym({ id: 'M@main::cortex:src/a.ts#hello_world', name: 'hello_world', file: 'src/a.ts' }),
  sym({ id: 'M@main::cortex:src/a.ts#helper', name: 'helper', file: 'src/a.ts' }),
  sym({ id: 'M@main::cortex:src/b.ts#hello_world', name: 'hello_world', file: 'src/b.ts' }),
  sym({
    id: 'M@main::cortex:src/c.ts#Foo.method',
    name: 'Foo.method',
    symbolKind: 'method',
    file: 'src/c.ts',
  }),
  sym({
    id: 'M@main::cortex:src/c.ts#Bar.method',
    name: 'Bar.method',
    symbolKind: 'method',
    file: 'src/c.ts',
  }),
  sym({ id: 'M@main::cortex:src/c.ts#Foo', name: 'Foo', symbolKind: 'class', file: 'src/c.ts' }),
]

// 1) exact name in a single file → resolved match.
{
  const r = matchSymbol(symbols, 'src/a.ts', 'helper')
  assert.equal(r.match?.id, 'M@main::cortex:src/a.ts#helper', 'helper resolves uniquely')
  assert.equal(r.candidates, undefined, 'no candidates on a unique match')
  ok('exact name in a single file resolves')
}

// 2) file scoping disambiguates a name present in two files.
{
  const r = matchSymbol(symbols, 'src/b.ts', 'hello_world')
  assert.equal(r.match?.id, 'M@main::cortex:src/b.ts#hello_world', 'file scope picks src/b.ts')
  ok('file scoping disambiguates a name present in multiple files')
}

// 3) Class.method exact dotted name.
{
  const r = matchSymbol(symbols, 'src/c.ts', 'Foo.method')
  assert.equal(r.match?.id, 'M@main::cortex:src/c.ts#Foo.method', 'Foo.method resolves')
  ok('Class.method exact dotted name resolves')
}

// 4) bare method name matches the dotted method when unambiguous within the file.
{
  const r = matchSymbol(symbols, 'src/a.ts', 'hello_world')
  assert.equal(r.match?.id, 'M@main::cortex:src/a.ts#hello_world')
  ok('bare name within one file resolves')
}

// 5) ambiguity → candidates, no single match. A bare `method` in src/c.ts
// matches BOTH Foo.method and Bar.method.
{
  const r = matchSymbol(symbols, 'src/c.ts', 'method')
  assert.equal(r.match, undefined, 'no single match on ambiguity')
  assert.ok(r.candidates && r.candidates.length === 2, 'two candidates for bare `method`')
  const ids = new Set(r.candidates!.map((c) => c.id))
  assert.ok(ids.has('M@main::cortex:src/c.ts#Foo.method'))
  assert.ok(ids.has('M@main::cortex:src/c.ts#Bar.method'))
  ok('ambiguous bare method returns candidates')
}

// 6) not found → neither match nor candidates.
{
  const r = matchSymbol(symbols, 'src/a.ts', 'does_not_exist')
  assert.equal(r.match, undefined)
  assert.ok(!r.candidates || r.candidates.length === 0, 'no candidates when nothing matches')
  ok('unknown symbol → not found')
}

// 7) wrong file for an existing name → not found (file scope is authoritative).
{
  const r = matchSymbol(symbols, 'src/a.ts', 'Foo.method')
  assert.equal(r.match, undefined, 'Foo.method is not in src/a.ts')
  ok('file scope excludes symbols defined elsewhere')
}

// 8) same-name across files WITHOUT a file scope (file='') → candidates across files.
{
  const r = matchSymbol(symbols, '', 'hello_world')
  assert.equal(r.match, undefined, 'cross-file duplicate is ambiguous without a file scope')
  assert.equal(r.candidates?.length, 2, 'both hello_world defs are candidates')
  ok('no file scope: duplicate name returns cross-file candidates')
}

console.log(`\n${passed} assertions passed.`)
