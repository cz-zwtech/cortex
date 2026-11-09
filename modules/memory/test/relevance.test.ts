import assert from 'node:assert/strict'
import test from 'node:test'

import { queryRelevance, terms } from '../server/relevance.js'
import { LEXICAL_ESTIMATOR } from '../server/reconcile.js'

const QUERY = 'how do consumers authenticate to the kafka broker'
const MEMORY =
  'Consumers authenticate to the production Kafka broker over SASL using a read-only ' +
  'service account, never the admin credentials.'

test('SAMENESS AND RELEVANCE ARE DIFFERENT QUESTIONS — the numbers show it', () => {
  // Jaccard is symmetric and between comparable documents. A query is neither.
  const jaccard = LEXICAL_ESTIMATOR.compare(QUERY, MEMORY)
  const coverage = queryRelevance(QUERY, MEMORY)

  assert.ok(coverage !== null)
  assert.ok(coverage! > 0.7, `coverage says the memory answers the query: ${coverage}`)
  // And the sameness estimator either refuses (short-text guard) or scores it low.
  assert.ok(jaccard === null || jaccard < 0.4, `jaccard: ${jaccard}`)
})

test('JACCARD HAS A CEILING BELOW 1 FOR ANY SHORT QUERY — it cannot be fixed by tuning', () => {
  // Even when every query term appears, Jaccard tops out at |Q|/|M|, because the
  // denominator counts every word the memory has and the query does not. The
  // metric penalises the memory for being informative, so no floor can rescue it.
  const q = 'kafka broker authentication'
  const m =
    'kafka broker authentication is performed with SASL credentials issued per service and ' +
    'rotated on a schedule by the platform team every quarter without exception'
  const ceiling = terms(q).size / terms(m).size
  assert.ok(ceiling < 0.5, `perfect-match ceiling is only ${ceiling.toFixed(3)}`)
  assert.equal(queryRelevance(q, m), 1, 'coverage correctly calls it a perfect match')
})

test('THE GUARD MADE THE LARGEST WEIGHT INERT FOR TYPICAL QUERIES', () => {
  // The estimator refuses short text, and a query is short by nature — so the
  // 0.55 similarity weight contributed NOTHING to most queries and ranking fell
  // through to recency and pins. Observed: two unrelated memories scoring
  // identically at 0.100 with sim=n/a.
  assert.equal(LEXICAL_ESTIMATOR.compare('kafka broker auth', MEMORY), null, 'cannot judge')
  assert.ok(queryRelevance('kafka broker auth', MEMORY)! > 0, 'coverage still answers')
})

test('coverage is ASYMMETRIC — that is the point, not a defect', () => {
  const a = 'kafka'
  const b = 'kafka broker authentication over SASL with rotated service credentials'
  assert.equal(queryRelevance(a, b), 1, 'the long text contains the short query')
  assert.ok(queryRelevance(b, a)! < 0.3, 'the short text does not contain the long query')
})

test('an unusable query is CANNOT JUDGE, never zero', () => {
  // "contains none of it" and "there was nothing to look for" are different
  // claims, and the ladder's whole discipline is that they must not collapse.
  assert.equal(queryRelevance('a to', MEMORY), null)
  assert.equal(queryRelevance('', MEMORY), null)
  assert.equal(queryRelevance('kafka', ''), 0, 'a real query against empty content IS zero')
})

test('coverage stays in [0,1], so the traversal ceiling stays admissible', () => {
  for (const [q, m] of [
    [QUERY, MEMORY],
    ['x'.repeat(5), MEMORY],
    [MEMORY, QUERY],
  ]) {
    const v = queryRelevance(q!, m!)
    if (v !== null) assert.ok(v >= 0 && v <= 1, `${v}`)
  }
})

test('very short tokens are dropped — they match everything and mean nothing', () => {
  assert.ok(!terms('a to the of kafka').has('to'))
  assert.ok(terms('a to the of kafka').has('kafka'))
})

test('a compound identifier in the text answers a query for one of its parts', () => {
  // The laptop memory said globex_admins; the question said admins.
  assert.equal(queryRelevance('admins', 'they share the globex_admins group role'), 1)
  assert.equal(queryRelevance('globex_admins', 'they share the globex_admins group role'), 1)
})
