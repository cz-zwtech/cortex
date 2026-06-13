/**
 * Parity + behaviour test for the SQLite port of server/graph/symbols.ts.
 *
 * Strategy:
 *   1. Open a temp SQLite DB (via CKN_GRAPH_DB_PATH set BEFORE importing db.ts).
 *   2. Seed it from a captured live-Kuzu snapshot of the `cortex` repo on `main`
 *      (test/graph/fixtures/cortex-symbols.json + cortex-graph.json) by driving
 *      the ported `__upsertSymbolsOn`. This proves the upsert + edge fold + the
 *      read paths in one shot.
 *   3. Run the ported `__blastRadiusOn` for the same inputs that produced the
 *      golden blast fixtures (captured from the live Kuzu server) and assert
 *      symbol-for-symbol parity, including cross-file dependents.
 *
 * Run: npx tsx test/graph/symbols.test.ts   (exits 0 on pass, 1 on fail)
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures')

// ── temp DB BEFORE importing the module under test ──────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-symbols-'))
const dbPath = path.join(tmpDir, 't.sqlite')
process.env.CKN_GRAPH_DB_PATH = dbPath
// The machine id the fixtures were captured under. Passed EXPLICITLY to every
// upsert/blast call so parity does not depend on the host's derived id.
const FIX_MACHINE = 'node-a-c5e3af1c'

const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'))

let failed = 0
function check(label: string, fn: () => void) {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (e: any) {
    failed++
    console.error(`  FAIL ${label}\n       ${e?.message ?? e}`)
  }
}

async function main() {
  const symbolsMod = await import('../../server/graph/symbols.js')
  const {
    __upsertSymbolsOn,
    __blastRadiusOn,
    listSymbols,
    getSymbol,
    listSymbolGraph,
    symbolStats,
    listSymbolViews,
    readGraphHeads,
    symbolsByMachine,
    symbolNeighborhood,
    forgetRepoSymbols,
    refChain2,
    qualifyId,
    parseQualifiedId,
    SYMBOL_EDGE_TABLES,
  } = symbolsMod

  // ── seed: rebuild a CodeGraphSnapshot from the captured cortex/main graph ──
  // listSymbols rows are NATURAL-id-derivable: parse each qualified id back to
  // its naturalId so __upsertSymbolsOn re-qualifies it identically.
  const symRows: any[] = readJson('cortex-symbols.json').symbols
  const graph = readJson('cortex-graph.json')

  const snapSymbols = symRows.map((r) => {
    const parsed = parseQualifiedId(String(r.id))
    assert.ok(parsed, `every fixture id parses: ${r.id}`)
    return {
      id: parsed!.naturalId, // snapshot carries the NATURAL id
      name: String(r.name ?? ''),
      symbolKind: String(r.symbolKind ?? ''),
      repo: String(r.repo ?? ''),
      file: String(r.file ?? ''),
      lang: String(r.lang ?? ''),
      line: Number(r.line ?? 0),
      signature: String(r.signature ?? ''),
    }
  })
  // edges: graph.edges carry qualified from/to + label. Convert to natural-id
  // snapshot edges (src/dst = naturalId, kind = label).
  const snapEdges = (graph.edges as any[]).map((e) => ({
    src: parseQualifiedId(String(e.from))!.naturalId,
    dst: parseQualifiedId(String(e.to))!.naturalId,
    kind: String(e.label),
  }))

  // Fold the snapshot in (this also exercises upsert/edge/centrality/head write).
  const upRes = await __upsertSymbolsOn(
    null,
    { symbols: snapSymbols, edges: snapEdges },
    {
      machine: FIX_MACHINE,
      branch: 'main',
      baseBranch: 'main',
      commitSha: 'deadbeef',
      dirty: false,
      reExtractedRepos: ['cortex'],
    },
  )

  console.log('\n[upsert]')
  check('upsert symbol count == fixture rows', () => {
    assert.equal(upRes.symbols, snapSymbols.length)
  })
  check('upsert repos == [cortex]', () => {
    assert.deepEqual(upRes.repos, ['cortex'])
  })

  // ── reads ──────────────────────────────────────────────────────────────
  console.log('\n[reads]')
  const listed = await listSymbols({ repo: 'cortex', branch: 'main', limit: 5000 })
  check('listSymbols returns every seeded symbol', () => {
    assert.equal(listed.length, snapSymbols.length)
  })
  check('listSymbols rows have boolean pinned/groundTruthValid', () => {
    for (const s of listed) {
      assert.equal(typeof s.pinned, 'boolean')
      assert.equal(typeof s.groundTruthValid, 'boolean')
    }
  })
  check('listSymbols ordered by centrality DESC', () => {
    for (let i = 1; i < listed.length; i++) {
      assert.ok(
        listed[i - 1].centrality >= listed[i].centrality,
        `centrality non-increasing at ${i}`,
      )
    }
  })

  const oneId = qualifyId(FIX_MACHINE, 'main', 'cortex:server/graph/db.ts#getConnection')
  const one = await getSymbol(oneId)
  check('getSymbol resolves a known qualified id', () => {
    assert.ok(one, `getSymbol(${oneId})`)
    assert.equal(one!.name, 'getConnection')
    assert.equal(one!.repo, 'cortex')
  })
  const missing = await getSymbol('no-such-id')
  check('getSymbol(missing) is null', () => assert.equal(missing, null))

  const stats = await symbolStats()
  check('symbolStats symbols count matches', () => {
    assert.equal(stats.symbols, snapSymbols.length)
  })
  check('symbolStats edges count matches folded edges', () => {
    assert.equal(stats.edges, upRes.edges)
  })
  check('symbolStats includes cortex repo', () => {
    assert.ok(stats.repos.some((r) => r.repo === 'cortex' && r.count === snapSymbols.length))
  })

  const sg = await listSymbolGraph({ repo: 'cortex', branch: 'main' })
  check('listSymbolGraph node count matches', () => {
    assert.equal(sg.nodes.length, snapSymbols.length)
  })
  check('listSymbolGraph edges are within-node-set', () => {
    const present = new Set(sg.nodes.map((n) => n.id))
    for (const e of sg.edges) {
      assert.ok(present.has(e.from) && present.has(e.to))
      assert.ok(SYMBOL_EDGE_TABLES.includes(e.label as any))
    }
  })

  const views = await listSymbolViews()
  check('listSymbolViews has cortex/main view with head freshness', () => {
    const v = views.find((x) => x.repo === 'cortex' && x.branch === 'main')
    assert.ok(v, 'cortex/main view exists')
    assert.equal(v!.symbols, snapSymbols.length)
    assert.equal(v!.commitSha, 'deadbeef')
    assert.equal(v!.dirty, false)
  })

  const heads = await readGraphHeads({ repo: 'cortex' })
  check('readGraphHeads returns the written head', () => {
    assert.equal(heads.length, 1)
    assert.equal(heads[0].commitSha, 'deadbeef')
    assert.equal(heads[0].baseBranch, 'main')
    assert.equal(typeof heads[0].dirty, 'boolean')
  })

  const byMachine = await symbolsByMachine()
  check('symbolsByMachine counts this machine', () => {
    assert.equal(byMachine[FIX_MACHINE], snapSymbols.length)
  })

  // refChain2 is the preserved 2-level pure helper (the legacy resolveRefChain
  // shape); N-level data-driven resolveRefChain is covered in ref-chain.test.ts.
  check('refChain2 single when branch==base', () => {
    assert.deepEqual(refChain2('main', 'main'), ['main'])
  })
  check('refChain2 pair when branch!=base', () => {
    assert.deepEqual(refChain2('feat/x', 'main'), ['feat/x', 'main'])
  })

  // symbolNeighborhood: getConnection is heavily imported → should have dependents
  const nb = await symbolNeighborhood(oneId, ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'REFERENCES'])
  check('symbolNeighborhood resolves symbol + arrays', () => {
    assert.ok(nb.symbol)
    assert.ok(Array.isArray(nb.dependents))
    assert.ok(Array.isArray(nb.dependencies))
  })

  // ── BLAST PARITY (the load-bearing assertion) ────────────────────────────
  console.log('\n[blast parity]')

  // Normalize a blast result for order-insensitive comparison: sort symbols by
  // id, sort each symbol's dependents by (edgeKind,id).
  const norm = (out: { symbols: any[] }) => {
    const syms = [...out.symbols]
      .map((s) => ({
        id: s.id,
        name: s.name,
        symbolKind: s.symbolKind,
        file: s.file,
        line: s.line,
        dependents: [...s.dependents]
          .map((d) => ({ id: d.id, name: d.name, file: d.file, line: d.line, edgeKind: d.edgeKind }))
          .sort((a, b) =>
            (a.edgeKind + ' ' + a.id).localeCompare(b.edgeKind + ' ' + b.id),
          ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
    return syms
  }

  async function blastParity(label: string, fixtureFile: string, callArgs: any) {
    const golden = norm(readJson(fixtureFile))
    const got = norm(await __blastRadiusOn(null, callArgs))
    check(`${label}: symbol-for-symbol parity`, () => {
      assert.deepEqual(got, golden)
    })
  }

  await blastParity('blast symbols.ts', 'blast-golden.json', {
    repo: 'cortex',
    paths: ['server/graph/symbols.ts'],
    machine: FIX_MACHINE,
    branch: 'main',
    baseBranch: 'main',
  })
  await blastParity('blast db.ts (61 deps)', 'blast-golden-db.json', {
    repo: 'cortex',
    paths: ['server/graph/db.ts'],
    machine: FIX_MACHINE,
    branch: 'main',
    baseBranch: 'main',
  })
  await blastParity('blast multi-path IMPORTS-only', 'blast-golden-multi.json', {
    repo: 'cortex',
    paths: ['server/graph/symbols.ts', 'server/graph/db.ts'],
    edgeKinds: ['IMPORTS'],
    machine: FIX_MACHINE,
    branch: 'main',
    baseBranch: 'main',
  })

  // ── blast edge cases ──────────────────────────────────────────────────────
  console.log('\n[blast edge cases]')
  const noRepo = await __blastRadiusOn(null, { repo: '', paths: ['x'] })
  check('blast empty repo -> []', () => assert.deepEqual(noRepo.symbols, []))
  const noPaths = await __blastRadiusOn(null, { repo: 'cortex', paths: [] })
  check('blast empty paths -> []', () => assert.deepEqual(noPaths.symbols, []))
  const unknownPath = await __blastRadiusOn(null, {
    repo: 'cortex',
    paths: ['does/not/exist.ts'],
    machine: FIX_MACHINE,
    branch: 'main',
    baseBranch: 'main',
  })
  check('blast unknown path -> []', () => assert.deepEqual(unknownPath.symbols, []))

  // dependents ids are NATURAL ids (no @branch::) — contract invariant.
  const dbBlast = await __blastRadiusOn(null, {
    repo: 'cortex',
    paths: ['server/graph/db.ts'],
    machine: FIX_MACHINE,
    branch: 'main',
    baseBranch: 'main',
  })
  check('dependent ids are natural (no qualification)', () => {
    for (const s of dbBlast.symbols)
      for (const d of s.dependents) assert.ok(!d.id.includes('@main::'), d.id)
  })

  // ── forgetRepoSymbols ──────────────────────────────────────────────────────
  console.log('\n[forget]')
  const removed = await forgetRepoSymbols('cortex')
  check('forgetRepoSymbols returns count', () => assert.equal(removed, snapSymbols.length))
  const afterStats = await symbolStats()
  check('forget drops all cortex symbols', () => assert.equal(afterStats.symbols, 0))
  check('forget drops all symbol edges', () => assert.equal(afterStats.edges, 0))
  const forgetAgain = await forgetRepoSymbols('cortex')
  check('forget is idempotent (0 the second time)', () => assert.equal(forgetAgain, 0))

  // ── teardown ───────────────────────────────────────────────────────────────
  const { closeGraph } = await import('../../server/graph/db.js')
  await closeGraph()
  fs.rmSync(tmpDir, { recursive: true, force: true })

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${failed} failure(s)`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('UNCAUGHT', e)
  process.exit(1)
})
