import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

import { MemoryStore } from '../server/store.js'
import { hashContent } from '../server/store.js'
import {
  guardedLexicalSimilarity,
  LEXICAL_ESTIMATOR,
  lexicalSimilarity,
  reconcile,
  type ReconcileInput,
} from '../server/reconcile.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')

const store = () => {
  const db = new Database(':memory:')
  db.exec(schema)
  return new MemoryStore(db)
}

const seed = (s: MemoryStore, over: Record<string, unknown> = {}) => {
  const input = {
    id: 'existing',
    source: '/memory/deploy.md',
    name: 'deploy-process',
    description: 'how we deploy',
    content: 'Deploy by running the release script on the build host, then wait for the health check to report green before switching traffic over to the new pods.',
    shape: 'workflow' as const,
    authorship: 'authored' as const,
    scope: 'user',
    pinned: false,
    protected: false,
    machine: 'node-a',
    authoredAt: 1000,
    ingestedAt: 1000,
    outcome: '',
    outcomeText: '',
    ...over,
  }
  s.upsert(input as never)
  return input
}

const input = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  slug: 'deploy-process',
  scope: 'user',
  content: 'Deploy by running the release script on the build host, then wait for the health check to report green before switching traffic over to the new pods.',
  contentHash: 'h-incoming',
  machine: 'node-a',
  ...over,
})

// ── rung 0 ───────────────────────────────────────────────────────────────────

test('rung 0: a declared id is CORROBORATED, not obeyed', () => {
  const s = store()
  seed(s)
  // Same id, but the slug disagrees, no session record, and the content is
  // unrelated — every authority signal absent. This is the hallucinated-id and
  // colliding-import case, and it must not write.
  const d = reconcile(
    input({ declaredId: 'existing', slug: 'something-else', content: 'Cats are largely nocturnal animals that hunt small prey at dusk and dawn, sleeping through the middle of the day in warm places.' }),
    { store: s },
  )
  assert.equal(d.action, 'link', 'never writes on an uncorroborated claim')
  assert.equal(d.settleable, true, 'and never terminates in silence')
})

test('rung 0: an honest full REWRITE is accepted on slug agreement alone', () => {
  // The case a similarity floor would have rejected: every word changed, which
  // is exactly what an honest rewrite looks like.
  const s = store()
  seed(s)
  const d = reconcile(
    input({ declaredId: 'existing', content: 'Ship the artifact from CI, verify the checksum against the manifest, and only then promote it to the release channel for customers.' }),
    { store: s },
  )
  assert.equal(d.rung, '0')
  assert.equal(d.action, 'update')
  assert.match(d.note, /slug agreement/)
})

test('rung 0: surfaced_in corroborates when the slug does not', () => {
  const s = store()
  seed(s)
  s.upsertHub({ id: 'sess-1', kind: 'session', name: 'sess-1' })
  s.observe('existing', 'sess-1', 'surfaced_in')

  const d = reconcile(
    input({
      declaredId: 'existing',
      slug: 'renamed-entirely',
      content: 'Nothing whatsoever in common with the other text, written deliberately to share as few tokens as possible with it.',
      sessionId: 'sess-1',
    }),
    { store: s },
  )
  assert.equal(d.action, 'update')
  assert.match(d.note, /surfaced to this session/)
})

test('rung 0: a settled-away id resolves forward instead of resurrecting', () => {
  const s = store()
  seed(s)
  s.settle('loser', 'existing')

  const d = reconcile(input({ declaredId: 'loser' }), { store: s })
  assert.equal(d.target, 'existing', 'the stale receipt still lands on the right node')
})

test('rung 0: an IMPORT never enters at rung 0 or 1', () => {
  // A foreign corpus declaring an id is asserting ITS identity space, not ours.
  const s = store()
  seed(s)
  const d = reconcile(input({ declaredId: 'existing', imported: true }), { store: s })
  assert.notEqual(d.rung, '0')
  assert.notEqual(d.rung, '1')
})

// ── rung 1 / 1c / 1x ─────────────────────────────────────────────────────────

test('rung 1: same slug plus RELATED content is an update', () => {
  const s = store()
  seed(s)
  const d = reconcile(
    // A real edit of the seeded memory: same fact, extra detail. This is what an
    // update actually looks like — distinct from a rewrite (rung 0, caught by
    // slug agreement) and from a different fact under the same slug (rung 1c).
    input({
      content:
        'Deploy by running the release script on the build host, then wait for the ' +
        'health check to report green before switching traffic over to the new pods. ' +
        'Roll back with the same script and the previous tag if it does not.',
    }),
    { store: s },
  )
  assert.equal(d.rung, '1')
  assert.equal(d.action, 'update')
})

test('rung 1c: same slug plus UNRELATED content keeps both — same machine', () => {
  // Two concurrent sessions on one machine reusing a natural slug for different
  // facts. Treating this as an update destroys the first, silently, with both
  // legitimate. "Same machine means sequential" is false on this fleet.
  const s = store()
  seed(s)
  const d = reconcile(input({ content: 'The staging database lives on port 5433 and is seeded nightly from an anonymised dump, so never point an integration test at the production port.' }), { store: s })
  assert.equal(d.rung, '1c')
  assert.equal(d.action, 'link')
  assert.equal(d.settleable, true)
})

test('rung 1x: unrelated content from another machine is CONCURRENT, not later', () => {
  const s = store()
  seed(s)
  const d = reconcile(
    input({ content: 'The staging database lives on port 5433 and is seeded nightly from an anonymised dump, so never point an integration test at the production port.', machine: 'wsl-box' }),
    { store: s },
  )
  assert.equal(d.rung, '1x')
  assert.equal(d.action, 'link')
})

// ── rung 2 ───────────────────────────────────────────────────────────────────

test('rung 2: identical text folds — this is crash-retry idempotency', () => {
  const s = store()
  seed(s)
  s.recordConsume('h-known', 'existing')

  const d = reconcile(input({ slug: '', contentHash: 'h-known' }), { store: s })
  assert.equal(d.rung, '2')
  assert.equal(d.action, 'fold')
})

test('rung 2: a cross-scope fold RECORDS the other scope rather than discarding it', () => {
  // A global hash key otherwise narrows relevance: the same fact saved in two
  // projects keeps only the first scope and ranks down in the second forever,
  // with nothing recording it was ever relevant there.
  const s = store()
  seed(s, { scope: 'project-a' })
  s.recordConsume('h-known', 'existing')

  const d = reconcile(input({ slug: '', scope: 'project-b', contentHash: 'h-known' }), { store: s })
  assert.equal(d.action, 'fold')
  assert.match(d.note, /also relevant in project-b/)
})

// ── rung 3 / 4 ───────────────────────────────────────────────────────────────

test('rung 3: a near-duplicate LINKS and does not merge', () => {
  const s = store()
  const existing = seed(s, { name: 'other-slug' })
  const d = reconcile(
    input({ slug: 'fresh-slug', content: existing.content + ' Also verify.' }),
    {
      store: s,
      candidates: () => [s.get('existing')!],
      estimator: { ...LEXICAL_ESTIMATOR, nearDuplicateFloor: 0.5 },
    },
  )
  assert.equal(d.rung, '3')
  assert.equal(d.action, 'link', 'never merge — 0.94 apart can still mean the opposite')
})

test('rung 4: nothing matched is a new node', () => {
  const s = store()
  const d = reconcile(input({ slug: 'brand-new', contentHash: 'h-new' }), { store: s })
  assert.equal(d.rung, '4')
  assert.equal(d.action, 'create')
})

// ── the similarity default ───────────────────────────────────────────────────

test('the default similarity is lexical and injectable', () => {
  assert.equal(lexicalSimilarity('a b c', 'a b c'), 1)
  assert.equal(lexicalSimilarity('a b c', 'x y z'), 0)

  // Injection wins over the default: a provider that calls everything identical
  // turns an unrelated-content collision into an update. Asserting the seam
  // works matters more than the number.
  const s = store()
  seed(s)
  const d = reconcile(input({ content: 'Short.' }), {
    store: s,
    // An injected estimator REPLACES the default's short-text guard AND brings
    // its own floors. The guard is a property of token overlap, not of
    // similarity in general — and the floors are a property of the estimator
    // that produced them, so they travel together or not at all.
    estimator: { name: 'always-identical', compare: () => 1, relatedFloor: 0.45, nearDuplicateFloor: 0.8, provisional: true },
  })
  assert.equal(d.rung, '1', 'the injected estimator is trusted, guard and all')
})

test('hashContent is stable', () => {
  assert.equal(hashContent('n', 'd', 'c'), hashContent('n', 'd', 'c'))
  assert.notEqual(hashContent('n', 'd', 'c'), hashContent('n', 'd', 'c2'))
})

test('CANNOT JUDGE is not "not similar" — short texts keep both, never overwrite', () => {
  // Below the token floor a Jaccard score moves in thirds and means nothing.
  // The verdict is UNKNOWN, and unknown resolves by recoverability: never an
  // irreversible update decided by a coin flip, always a settleable pair.
  const s = store()
  seed(s, { content: 'Port is 8080.' })

  const d = reconcile(input({ content: 'Port is 8081.' }), { store: s })
  assert.equal(d.action, 'link', 'never an update on an unjudgeable signal')
  assert.equal(d.settleable, true)
  assert.match(d.note, /too short to compare/)
})

test('the guard belongs to the estimator, and says so in its return type', () => {
  const guarded = guardedLexicalSimilarity()
  assert.equal(guarded('one two', 'one three'), null, 'cannot judge')
  assert.notEqual(
    guarded(
      'one two three four five six seven eight nine ten eleven twelve',
      'one two three four five six seven eight nine ten eleven twelve',
    ),
    null,
    'long enough to judge',
  )
})

test('rung 2 does NOT consult similarity — exact is exact at any length', () => {
  // The guard must not reach the fold path: a byte-identical retry of a
  // three-word memory is still a retry.
  const s = store()
  seed(s, { content: 'Port is 8080.' })
  s.recordConsume('h-tiny', 'existing')

  const d = reconcile(input({ slug: '', content: 'Port is 8080.', contentHash: 'h-tiny' }), {
    store: s,
  })
  assert.equal(d.rung, '2')
  assert.equal(d.action, 'fold')
})

test('THRESHOLDS TRAVEL WITH THE ESTIMATOR — they are not portable numbers', () => {
  // The failure this prevents arrives weeks after a swap and never fails a test:
  // every floor here is calibrated against lexical Jaccard, and a cosine
  // distribution is not the same shape, so a number meaning "near-identical"
  // under one means "vaguely related" under the other. Recall just gets quietly
  // worse in a direction nobody is measuring.
  //
  // So the ladder takes no threshold parameter at all. Supplying an estimator
  // necessarily supplies its calibration, and applying Jaccard's floors to
  // embeddings is not expressible.
  assert.equal(LEXICAL_ESTIMATOR.provisional, true, 'and these numbers are labelled as chosen')

  const s = store()
  seed(s)
  const strict = { ...LEXICAL_ESTIMATOR, name: 'strict', relatedFloor: 0.99 }
  const edit = input({
    content:
      'Deploy by running the release script on the build host, then wait for the ' +
      'health check to report green before switching traffic over to the new pods. ' +
      'Roll back with the same script and the previous tag if it does not.',
  })

  assert.equal(reconcile(edit, { store: s }).rung, '1', 'an update under the default floor')
  assert.equal(
    reconcile(edit, { store: s, estimator: strict }).rung,
    '1c',
    'and a collision under a stricter one — the floor came from the estimator',
  )
})
