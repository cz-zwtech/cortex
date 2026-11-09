import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LEXICAL_ESTIMATOR } from '../server/reconcile.js'
import { read, readCorpus } from '../calibrate/corpus.js'
import { DEFAULT_BANDS, bandOf, mineNaturalPairs, pairKey, samplePairs } from '../calibrate/pairs.js'
import {
  DEFAULT_MAX_FALSE_MERGE_RATE,
  calibrate,
  checkControl,
  joinLabels,
  recommend,
  sweep,
  type LabelledPair,
} from '../calibrate/score.js'

const entry = (id: string, body: string, over: Record<string, unknown> = {}) => ({
  id,
  source: `/mem/${id}.md`,
  slug: '',
  scope: 'user',
  body,
  ...over,
})

// ── the objective function ───────────────────────────────────────────────────

test('THE RULE IS LOWEST-SAFE, NOT HIGHEST — a floor that never fires is not an answer', () => {
  // The direction is the whole point. Raising a floor monotonically reduces
  // merges, so the highest floor satisfies any safety target by merging nothing
  // and needs no instrument to find. The floor worth measuring is the most
  // permissive one that is still safe.
  const pairs: LabelledPair[] = [
    { key: 'a', label: 'same', score: 0.6 },
    { key: 'b', label: 'same', score: 0.7 },
    { key: 'c', label: 'different', score: 0.5 },
  ]
  const r = recommend(sweep(pairs, [0.4, 0.55, 0.65, 0.9]))
  assert.equal(r.floor, 0.55, 'the lowest floor that admits no false merge')
  assert.notEqual(r.floor, 0.9, 'not the safest-by-doing-nothing floor')
})

test('a floor that judges NOTHING the same is skipped, not recommended', () => {
  const pairs: LabelledPair[] = [
    { key: 'a', label: 'same', score: 0.3 },
    { key: 'b', label: 'different', score: 0.2 },
  ]
  // At 0.9 nothing fires: zero false merges, vacuously "safe".
  const r = recommend(sweep(pairs, [0.9]))
  assert.equal(r.floor, null)
  assert.equal(r.unattainable, true)
})

test('UNATTAINABLE IS A REAL RESULT — it indicts the estimator, not the sweep', () => {
  // Perfectly overlapping classes: no floor separates them. The harness must say
  // so rather than emitting the least-bad number, because a number handed back
  // here would be cited later as measured.
  const pairs: LabelledPair[] = [
    { key: 'a', label: 'same', score: 0.5 },
    { key: 'b', label: 'different', score: 0.5 },
  ]
  const r = recommend(sweep(pairs, [0, 0.25, 0.5, 0.75]))
  assert.equal(r.floor, null)
  assert.equal(r.unattainable, true)
  assert.match(r.rationale, /about the ESTIMATOR/)
})

test('F1 WOULD PICK DIFFERENTLY, AND THAT IS THE POINT', () => {
  // Nine duplicates sit at 0.5; one genuinely different pair sits there too.
  // A balanced metric takes the lower floor: nine catches for one false merge is
  // an excellent trade by F1 and an unacceptable one here, because the merge is
  // irreversible and the nine duplicates are not.
  const pairs: LabelledPair[] = [
    ...Array.from({ length: 9 }, (_, i) => ({ key: `s${i}`, label: 'same' as const, score: 0.5 })),
    { key: 'd', label: 'different' as const, score: 0.5 },
    { key: 's9', label: 'same' as const, score: 0.8 },
  ]
  const r = recommend(sweep(pairs, [0.4, 0.7]))
  assert.equal(r.floor, 0.7, 'refuses the trade F1 would take')
  assert.equal(r.price?.duplicatesLeft, 9, 'and reports the price honestly')
})

test('a merged CONTRADICTION is a false merge and is counted separately', () => {
  const [res] = sweep([{ key: 'c', label: 'contradicts', score: 0.95 }], [0.9])
  assert.equal(res!.falseMerges, 1)
  assert.equal(res!.contradictionMerges, 1)
})

test('CANNOT JUDGE IS NEVER A MERGE, and an unjudgeable duplicate still counts as left behind', () => {
  // Folding abstention into either class would make the harness disagree with
  // the system it is calibrating, where cannot-judge is a first-class answer.
  const [res] = sweep(
    [
      { key: 'a', label: 'same', score: null },
      { key: 'b', label: 'different', score: null },
    ],
    [0],
  )
  assert.equal(res!.falseMerges, 0)
  assert.equal(res!.truePositives, 0)
  assert.equal(res!.duplicatesLeft, 1, 'the same-pair was not collapsed, so it is a duplicate left')
  assert.equal(res!.cannotJudge, 2)
})

test('the default false-merge ceiling is ZERO', () => {
  // On a few hundred labelled pairs, "one false merge is acceptable" is a
  // rounding error promoted to a policy rather than a calibrated risk appetite.
  assert.equal(DEFAULT_MAX_FALSE_MERGE_RATE, 0)
})

// ── the blind-labelling split ────────────────────────────────────────────────

test('THE LABEL SHEET CONTAINS NO SCORE — structurally, not by instruction', () => {
  // A rule saying "do not look at the score" is exactly the kind of rule whose
  // violation leaves no evidence. So the sheet is a different artifact.
  const corpus = [
    entry('a', 'the deployment script runs on the build host and waits for a green health check'),
    entry('b', 'the deployment script runs on the build host and waits for green health checks'),
    entry('c', 'cats sleep through the middle of the day in warm places near windows'),
  ]
  const { sheet, meta } = samplePairs(corpus, { estimator: LEXICAL_ESTIMATOR, perBand: 5 })

  assert.ok(sheet.length > 0)
  for (const row of sheet) {
    assert.ok(!('score' in row), 'a labeller must not be able to see the score')
    assert.equal(row.label, null, 'and ships unlabelled')
  }
  assert.ok(meta.every((m) => 'score' in m), 'the scores live in the other artifact')
  assert.deepEqual(
    new Set(sheet.map((r) => r.key)),
    new Set(meta.map((m) => m.key)),
    'joined by key, one to one',
  )
})

test('SHEET ORDER LEAKS NOTHING — position must not encode the band', () => {
  // Buckets are built in band order, so emitting them flat puts the sheet in
  // ascending similarity and a labeller working top-to-bottom infers each pair's
  // band from where it sits. That is the score arriving by the back door, into
  // the one artifact built to withhold it.
  const corpus = Array.from({ length: 20 }, (_, i) =>
    entry(
      `m${i}`,
      i % 2 === 0
        ? `deployment release script build host green health check pods traffic switch ${i}`
        : `unrelated subject ${i} about feline nocturnal behaviour and warm window ledges`,
    ),
  )
  const { sheet, meta } = samplePairs(corpus, { estimator: LEXICAL_ESTIMATOR, perBand: 6 })
  const bandOfKey = new Map(meta.map((m) => [m.key, m.band]))
  const bands = sheet.map((r) => bandOfKey.get(r.key)!).filter((b) => b !== undefined)

  const sortedAsc = [...bands].every((b, i) => i === 0 || bands[i - 1]! <= b)
  assert.ok(!sortedAsc || new Set(bands).size <= 1, 'sheet order must not be band order')
  assert.deepEqual(
    sheet.map((r) => r.key),
    [...sheet.map((r) => r.key)].sort(),
    'ordered by content-hash key, which is independent of similarity',
  )
})

test('sampling is DETERMINISTIC — a fixture you cannot reproduce cannot be audited', () => {
  const corpus = Array.from({ length: 12 }, (_, i) =>
    entry(`m${i}`, `memory number ${i} about deployment pipelines and health checking on hosts`),
  )
  const a = samplePairs(corpus, { estimator: LEXICAL_ESTIMATOR })
  const b = samplePairs(corpus, { estimator: LEXICAL_ESTIMATOR })
  assert.deepEqual(a.sheet, b.sheet)
  assert.deepEqual(a.meta, b.meta)
})

test('NO SINGLE MEMORY DOMINATES THE SAMPLE — the defect a passing suite hid', () => {
  // The first version of the sampler used nested `for i … for j>i`, which offers
  // every pair (corpus[0], X) before advancing i. The low-similarity bands fill
  // instantly because almost everything is dissimilar, so they filled ENTIRELY
  // with pairs anchored on one memory. Deterministic: yes. Stratified by score:
  // yes. Representative: not at all — and the suite was green throughout,
  // because representativeness was a property nobody had asserted.
  //
  // Found by reading the generated sheet and noticing every A was identical.
  const corpus = Array.from({ length: 30 }, (_, i) =>
    entry(
      `m${i}`,
      `distinct memory ${i} concerning subject ${i} with vocabulary specific to topic ${i} ` +
        `and nothing shared beyond ordinary connective words used in prose`,
    ),
  )
  const { sheet } = samplePairs(corpus, { estimator: LEXICAL_ESTIMATOR, perBand: 12 })

  const appearances = new Map<string, number>()
  for (const row of sheet) {
    for (const id of row.key.split('|')) {
      appearances.set(id, (appearances.get(id) ?? 0) + 1)
    }
  }
  const worst = Math.max(...appearances.values())
  assert.ok(
    worst <= 4,
    `no memory should anchor the sample; worst appears ${worst} times across bands`,
  )
  assert.ok(appearances.size >= 10, 'the sample must touch many memories, not one against all')
})

test('the per-anchor cap is configurable and enforced within a band', () => {
  const corpus = Array.from({ length: 12 }, (_, i) =>
    entry(`m${i}`, `shared deployment pipeline vocabulary for host ${i} with green health checks`),
  )
  const { sheet, meta } = samplePairs(corpus, {
    estimator: LEXICAL_ESTIMATOR,
    perBand: 12,
    maxPerAnchor: 1,
  })
  const byBand = new Map<number, string[]>()
  for (const m of meta) {
    const row = sheet.find((r) => r.key === m.key)!
    byBand.set(m.band, [...(byBand.get(m.band) ?? []), ...row.key.split('|')])
  }
  for (const [band, ids] of byBand) {
    assert.equal(new Set(ids).size, ids.length, `band ${band} reused a member under cap 1`)
  }
})

test('cannot-judge pairs get their own band rather than being dropped', () => {
  const corpus = [entry('a', 'Port 8080.'), entry('b', 'Port 8081.')]
  const { report, meta } = samplePairs(corpus, { estimator: LEXICAL_ESTIMATOR })
  assert.equal(report.cannotJudge, 1)
  assert.equal(meta[0]!.score, null)
})

test('UNDERFILLED BANDS ARE REPORTED — an empty band is a finding about the corpus', () => {
  const corpus = [entry('a', 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu')]
  const { report } = samplePairs(corpus, { estimator: LEXICAL_ESTIMATOR, perBand: 4 })
  assert.equal(report.totalPairs, 0)
  assert.ok(report.underfilled.length > 0, 'silence about coverage would read as coverage')
})

test('bandOf places scores in the intended band', () => {
  assert.equal(DEFAULT_BANDS[bandOf(0.0, DEFAULT_BANDS)], 0)
  assert.equal(DEFAULT_BANDS[bandOf(0.46, DEFAULT_BANDS)], 0.45)
  assert.equal(DEFAULT_BANDS[bandOf(1.0, DEFAULT_BANDS)], 1.0)
})

// ── labels ───────────────────────────────────────────────────────────────────

test('UNLABELLED ROWS ARE DROPPED AND COUNTED, never defaulted to `different`', () => {
  // Defaulting would pad the safe class with every pair the labeller skipped —
  // and the safe class is exactly what the objective function is protecting.
  const sheet = [
    { key: 'k1', aText: '', bText: '', label: 'same' as const },
    { key: 'k2', aText: '', bText: '', label: null },
  ]
  const meta = [
    { key: 'k1', score: 0.9, sampledBy: 'x', band: 1 },
    { key: 'k2', score: 0.9, sampledBy: 'x', band: 1 },
  ]
  const { pairs, unlabelled } = joinLabels(sheet, meta)
  assert.equal(pairs.length, 1)
  assert.equal(unlabelled, 1)
})

test('a labelled row with no score is counted as unscored, not as cannot-judge', () => {
  const { pairs, unscored } = joinLabels(
    [{ key: 'orphan', aText: '', bText: '', label: 'same' }],
    [],
  )
  assert.equal(pairs.length, 0)
  assert.equal(unscored, 1)
})

test('pairKey is order-independent', () => {
  assert.equal(pairKey('a', 'b'), pairKey('b', 'a'))
})

// ── the held-out control ─────────────────────────────────────────────────────

test('natural pairs are mined UNLABELLED and marked as controls', () => {
  const corpus = [
    entry('a', 'deploy via the release script and wait for green', { slug: 'deploy' }),
    entry('b', 'deploy via the release script, wait for green, then switch traffic', {
      slug: 'deploy',
    }),
    entry('c', 'identical body', { slug: 'other' }),
    entry('d', 'identical body', { slug: 'other' }),
  ]
  const { sheet: natural, meta } = mineNaturalPairs(corpus, 240, LEXICAL_ESTIMATOR)
  assert.equal(natural.length, 1, 'identical bodies are replication, not a re-save')
  assert.equal(natural[0]!.label, null, 'nobody judged these — that is their value')
  assert.equal(natural[0]!.control, true)
  assert.equal(meta.length, 1, 'and they ARE scored — in the meta artifact, never the sheet')
})

test('CONTROLS SURVIVE joinLabels — the held-out check was inert without this', () => {
  // Two mechanisms, each correct alone, contradicting at the seam: controls ship
  // unlabelled on purpose, and joinLabels drops unlabelled rows. So checkControl
  // ran over an empty array and reported total: 0 — a check that silently checked
  // nothing. Caught only because the first real run printed the zero.
  //
  // A control's label comes from the CORPUS (same slug, same scope, different
  // body = a re-save), not from a labeller, so `same` is not a default here.
  const { pairs, controls, unlabelled } = joinLabels(
    [
      { key: 'k1', aText: '', bText: '', label: 'same' },
      { key: 'k2', aText: '', bText: '', label: null, control: true },
      { key: 'k3', aText: '', bText: '', label: null },
    ],
    [
      { key: 'k1', score: 0.9, sampledBy: 'x', band: 1 },
      { key: 'k2', score: 0.5, sampledBy: 'x:natural', band: -1 },
      { key: 'k3', score: 0.5, sampledBy: 'x', band: 1 },
    ],
  )
  assert.equal(controls, 1, 'the control was kept')
  assert.equal(unlabelled, 1, 'the genuinely unlabelled row was still dropped')
  assert.equal(pairs.find((p) => p.key === 'k2')?.label, 'same')
  assert.equal(pairs.find((p) => p.key === 'k2')?.control, true)
})

test('CONTROLS ARE EXCLUDED FROM THE OBJECTIVE — a check, not a second training signal', () => {
  const pairs: LabelledPair[] = [
    { key: 'a', label: 'same', score: 0.6 },
    { key: 'b', label: 'different', score: 0.5 },
    // A control that, if scored, would forbid the 0.55 floor.
    { key: 'ctl', label: 'different', score: 0.99, control: true },
  ]
  const { recommendation, control } = calibrate(pairs, { floors: [0.55, 0.9] })
  assert.equal(recommendation.floor, 0.55, 'the control did not move the recommendation')
  assert.equal(control?.total, 1, 'but it is reported')
})

test('checkControl reports splits — the corpus disagreeing with the labels', () => {
  const out = checkControl([{ key: 'x', score: 0.4 }, { key: 'y', score: 0.95 }], 0.8)
  assert.equal(out.judgedSame, 1)
  assert.equal(out.split, 1)
})

// ── corpus reading ───────────────────────────────────────────────────────────

test('the corpus reader takes bodies, skips indexes, and dedupes replication', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-corpus-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const dir = path.join(root, 'memory')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'one.md'), '---\nname: alpha\n---\n\nAlpha body text here.\n')
  fs.writeFileSync(path.join(dir, 'two.md'), '---\nname: beta\n---\n\nAlpha body text here.\n')
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '---\nname: idx\n---\n\nAn index, not a memory.\n')

  const corpus = readCorpus([root])
  assert.equal(corpus.length, 1, 'identical bodies collapse; the index is skipped')
  assert.equal(corpus[0]!.slug, 'alpha')
  assert.ok(!corpus[0]!.body.includes('name:'), 'frontmatter would inflate every similarity')
})

test('AUTO-EXTRACTED SCAFFOLDING IS EXCLUDED — it would have set the floor by template', async (t) => {
  // Cortex writes one node per session and one per tool into the memory dirs.
  // They are template instances differing by a token, and they ARE different
  // from each other — so labelling them honestly as `different` forces the
  // near-duplicate floor UP to avoid merging them. The floor would then be
  // determined by the shape of a template rather than by any judgement about
  // facts, while looking every bit as derived.
  //
  // Measured: with these included, the 0.8–0.95 bands filled almost entirely
  // with pairs of them.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-corpus3-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'memory')
  fs.mkdirSync(dir, { recursive: true })

  fs.writeFileSync(
    path.join(dir, 'real.md'),
    '---\nname: real\n---\n\nAn actual authored memory about deployment.\n',
  )
  fs.writeFileSync(
    path.join(dir, 'session-x.md'),
    '---\nname: sess\ntype: session\nauthorship: auto-extracted\n---\n\nSession entry — 12 turns.\n',
  )
  fs.writeFileSync(
    path.join(dir, 'concept-read.md'),
    '---\nname: Read\ntype: concept\nauthorship: auto-extracted\n---\n\nAuto-generated concept node.\n',
  )

  const { corpus, report } = read([root])
  assert.equal(corpus.length, 1)
  assert.equal(report.autoExtracted, 2, 'and the exclusion is COUNTED, never silent')

  // Keyed on the corpus's own declaration, so it cannot drift as templates change.
  assert.equal(read([root], { includeAutoExtracted: true }).corpus.length, 3)
})

test('a file outside a memory/ segment is not corpus', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-corpus2-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'notes.md'), '---\nname: x\n---\n\nSome project notes.\n')
  assert.deepEqual(readCorpus([root]), [])
})
