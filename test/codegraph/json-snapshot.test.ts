import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonSnapshotStore } from '../../server/codegraph/adapters/json-snapshot.ts';
import { symbolId, newLifecycle, type ExtractResult, type SymbolNode } from '../../server/codegraph/types.ts';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

function sym(repo: string, file: string, name: string, now = T0): SymbolNode {
  return {
    id: symbolId(repo, file, name),
    kind: 'symbol',
    name,
    symbolKind: 'function',
    repo,
    file,
    lang: 'ts',
    line: 1,
    lifecycle: newLifecycle(now),
  };
}

// A tiny graph: store.ts imports lifecycle.ts; 3 callers of `decayedRelevance`.
function fixture(): ExtractResult {
  const repo = 'codegraph';
  const decay = sym(repo, 'src/lifecycle.ts', 'decayedRelevance');
  const store = sym(repo, 'src/adapters/json-snapshot.ts', 'JsonSnapshotStore');
  const a = sym(repo, 'src/a.ts', 'a');
  const b = sym(repo, 'src/b.ts', 'b');
  return {
    symbols: [decay, store, a, b],
    edges: [
      { src: store.id, dst: decay.id, kind: 'CALLS' },
      { src: a.id, dst: decay.id, kind: 'CALLS' },
      { src: b.id, dst: decay.id, kind: 'CALLS' },
      { src: store.id, dst: decay.id, kind: 'IMPORTS' },
    ],
  };
}

describe('JsonSnapshotStore — blast radius', () => {
  let store: JsonSnapshotStore;
  beforeEach(async () => {
    store = new JsonSnapshotStore();
    await store.upsert(fixture(), { now: T0 });
  });

  it('dependents() returns everything that calls/imports a symbol', async () => {
    const id = symbolId('codegraph', 'src/lifecycle.ts', 'decayedRelevance');
    const deps = await store.dependents(id);
    assert.equal(deps.length, 3, 'JsonSnapshotStore + a + b');
    const names = deps.map((d) => d.name).sort();
    assert.deepEqual(names, ['JsonSnapshotStore', 'a', 'b']);
  });

  it('dependents() can filter by edge kind', async () => {
    const id = symbolId('codegraph', 'src/lifecycle.ts', 'decayedRelevance');
    const importers = await store.dependents(id, ['IMPORTS']);
    assert.equal(importers.length, 1);
    assert.equal(importers[0]!.name, 'JsonSnapshotStore');
  });

  it('dependencies() returns outgoing targets', async () => {
    const storeId = symbolId('codegraph', 'src/adapters/json-snapshot.ts', 'JsonSnapshotStore');
    const out = await store.dependencies(storeId);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.name, 'decayedRelevance');
  });

  it('dedupes a symbol reached via multiple edge kinds', async () => {
    // JsonSnapshotStore both CALLS and IMPORTS decayedRelevance.
    const id = symbolId('codegraph', 'src/lifecycle.ts', 'decayedRelevance');
    const deps = await store.dependents(id);
    const storeHits = deps.filter((d) => d.name === 'JsonSnapshotStore');
    assert.equal(storeHits.length, 1);
  });
});

describe('JsonSnapshotStore — centrality → stickiness', () => {
  it('makes a high-fan-in symbol sticky', async () => {
    const store = new JsonSnapshotStore();
    await store.upsert(fixture(), { now: T0 });
    await store.recomputeCentrality(T0);
    const decay = await store.get(symbolId('codegraph', 'src/lifecycle.ts', 'decayedRelevance'));
    // in-degree 4 → centralityStickiness ≈ 0.63
    assert.ok(decay!.lifecycle.stickiness > 0.5, `got ${decay!.lifecycle.stickiness}`);
    // a leaf with no dependents stays at 0
    const a = await store.get(symbolId('codegraph', 'src/a.ts', 'a'));
    assert.equal(a!.lifecycle.stickiness, 0);
  });
});

describe('JsonSnapshotStore — provable staleness on re-extract', () => {
  it('marks a vanished symbol ground-truth-invalid and forgets it', async () => {
    const store = new JsonSnapshotStore();
    await store.upsert(fixture(), { now: T0 });

    // Re-extract the repo WITHOUT symbol `a` (it was deleted from source).
    const next = fixture();
    next.symbols = next.symbols.filter((s) => s.name !== 'a');
    next.edges = next.edges.filter((e) => !e.src.endsWith('#a'));
    await store.upsert(next, { now: T0 + DAY, reExtractedRepo: 'codegraph' });

    const a = await store.get(symbolId('codegraph', 'src/a.ts', 'a'));
    assert.equal(a!.lifecycle.groundTruthValid, false);

    const { archived } = await store.forgetBelow(0.2, T0 + DAY);
    assert.ok(archived.includes(symbolId('codegraph', 'src/a.ts', 'a')));
    assert.equal(await store.get(symbolId('codegraph', 'src/a.ts', 'a')), null);
    assert.ok(store.isArchived(symbolId('codegraph', 'src/a.ts', 'a')));
  });

  it('re-validates ground truth when a symbol reappears', async () => {
    const store = new JsonSnapshotStore();
    await store.upsert(fixture(), { now: T0 });
    // First removal pass marks `b` invalid.
    const without = fixture();
    without.symbols = without.symbols.filter((s) => s.name !== 'b');
    await store.upsert(without, { now: T0 + DAY, reExtractedRepo: 'codegraph' });
    assert.equal((await store.get(symbolId('codegraph', 'src/b.ts', 'b')))!.lifecycle.groundTruthValid, false);
    // It comes back in the next pass.
    await store.upsert(fixture(), { now: T0 + 2 * DAY, reExtractedRepo: 'codegraph' });
    assert.equal((await store.get(symbolId('codegraph', 'src/b.ts', 'b')))!.lifecycle.groundTruthValid, true);
  });
});

describe('JsonSnapshotStore — pin protects from forgetting', () => {
  it('keeps a pinned stale node', async () => {
    const store = new JsonSnapshotStore();
    await store.upsert(fixture(), { now: T0 });
    const aId = symbolId('codegraph', 'src/a.ts', 'a');
    await store.pin(aId);
    const { archived } = await store.forgetBelow(0.2, T0 + 365 * DAY);
    assert.ok(!archived.includes(aId));
    assert.ok(await store.get(aId));
  });
});

describe('JsonSnapshotStore — persistence', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codegraph-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips through a JSON file', async () => {
    const path = join(dir, 'graph.json');
    const a = new JsonSnapshotStore({ path });
    await a.upsert(fixture(), { now: T0 });
    a.save();
    assert.ok(existsSync(path));

    const b = new JsonSnapshotStore({ path });
    const deps = await b.dependents(symbolId('codegraph', 'src/lifecycle.ts', 'decayedRelevance'));
    assert.equal(deps.length, 3);
  });
});
