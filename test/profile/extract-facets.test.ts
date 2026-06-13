#!/usr/bin/env tsx
/** Pure parse of the facet-extraction LLM response (no API call). */
import assert from 'node:assert/strict'
import { parseFacetResponse } from '../../bin/_profile-facets.js'

let passed = 0; const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const raw = '```json\n' + JSON.stringify({ facets: [
  { dimension: 'communication', facet_key: 'verbosity', stance: 'terse',
    statement: 'Prefers terse answers', valence: 'trait', classification: 'perception' },
  { dimension: 'bogus', facet_key: 'x', stance: 'y', statement: 'z', valence: 'trait', classification: 'perception' },
  { dimension: 'communication', facet_key: 'tone', stance: 'formal', statement: 'keep it formal now',
    valence: 'neutral', classification: 'override' },
] }) + '\n```'

const facets = parseFacetResponse(raw)
assert.equal(facets.length, 2, 'invalid dimension dropped, valid + override kept')
assert.equal(facets[0]!.dimension, 'communication')
assert.equal(facets[1]!.classification, 'override', 'override preserved for downstream filtering')
ok('parseFacetResponse validates + keeps classification')
console.log(`\n${passed} assertions passed.`)
