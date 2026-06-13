import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractRepo } from '../../server/codegraph/extract/index.ts';
import { symbolId } from '../../server/codegraph/types.ts';

const T0 = 1_700_000_000_000;

describe('extractTypeScript (via extractRepo)', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cg-ts-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'base.ts'), `export class Base {\n  greet() { return 'hi'; }\n}\nexport interface Opts { x: number }\nexport type Id = string;\nexport function util() { return 7; }\n`);
    writeFileSync(join(dir, 'src', 'store.ts'), `import { Base, util } from './base.ts';\nimport type { Opts } from './base.ts';\nexport class Store extends Base {\n  load(o: Opts) { return this.compute(); }\n  compute() { return util(); }\n}\nexport function makeStore() { return new Store(); }\nexport const helper = () => makeStore();\n`);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('extracts module/class/interface/type/function/method symbols', async () => {
    const { symbols } = await extractRepo(dir, { repo: 'fix', langs: ['ts'], now: T0 });
    const names = new Set(symbols.map((s) => `${s.symbolKind}:${s.name}`));
    assert.ok(names.has('class:Base'), 'Base class');
    assert.ok(names.has('class:Store'), 'Store class');
    assert.ok(names.has('interface:Opts'), 'Opts interface');
    assert.ok(names.has('type:Id'), 'Id type');
    assert.ok(names.has('function:makeStore'), 'makeStore function');
    assert.ok(names.has('function:helper'), 'exported arrow → function');
    assert.ok(names.has('method:Base.greet'), 'Base.greet method');
    assert.ok([...names].some((n) => n.startsWith('module:')), 'module symbols');
  });

  it('emits an intra-repo IMPORTS edge store → base', async () => {
    const { edges } = await extractRepo(dir, { repo: 'fix', langs: ['ts'], now: T0 });
    const imports = edges.filter((e) => e.kind === 'IMPORTS');
    assert.ok(
      imports.some((e) => e.src === symbolId('fix', 'src/store.ts', '<module>') && e.dst === symbolId('fix', 'src/base.ts', '<module>')),
      `expected store→base IMPORTS, got ${JSON.stringify(imports)}`,
    );
  });

  it('emits an EXTENDS edge Store → Base', async () => {
    const { edges } = await extractRepo(dir, { repo: 'fix', langs: ['ts'], now: T0 });
    const ext = edges.filter((e) => e.kind === 'EXTENDS');
    assert.ok(
      ext.some((e) => e.src === symbolId('fix', 'src/store.ts', 'Store') && e.dst === symbolId('fix', 'src/base.ts', 'Base')),
      `expected Store→Base EXTENDS, got ${JSON.stringify(ext)}`,
    );
  });

  it('emits CALLS edges (intra-file, cross-import, method) with no dangling targets', async () => {
    const { symbols, edges } = await extractRepo(dir, { repo: 'fix', langs: ['ts'], now: T0 });
    const calls = edges.filter((e) => e.kind === 'CALLS');
    const sid = (file: string, name: string) => symbolId('fix', file, name);

    // method → cross-import function: Store.compute() calls util() from base.ts
    assert.ok(
      calls.some((e) => e.src === sid('src/store.ts', 'Store.compute') && e.dst === sid('src/base.ts', 'util')),
      `expected Store.compute→base.util CALLS, got ${JSON.stringify(calls)}`,
    );
    // method → method (same class): Store.load() calls this.compute()
    assert.ok(
      calls.some((e) => e.src === sid('src/store.ts', 'Store.load') && e.dst === sid('src/store.ts', 'Store.compute')),
      `expected Store.load→Store.compute CALLS, got ${JSON.stringify(calls)}`,
    );
    // arrow const → function: helper() calls makeStore()
    assert.ok(
      calls.some((e) => e.src === sid('src/store.ts', 'helper') && e.dst === sid('src/store.ts', 'makeStore')),
      `expected helper→makeStore CALLS, got ${JSON.stringify(calls)}`,
    );

    // No dangling edges: every CALLS endpoint is an extracted symbol.
    const ids = new Set(symbols.map((s) => s.id));
    for (const e of calls) {
      assert.ok(ids.has(e.src), `dangling CALLS src ${e.src}`);
      assert.ok(ids.has(e.dst), `dangling CALLS dst ${e.dst}`);
    }
  });
});

describe('extractPython (via extractRepo)', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cg-py-'));
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'pkg', 'base.py'), `class Base:\n    def greet(self):\n        return 'hi'\n\ndef top_level():\n    return 1\n`);
    writeFileSync(join(dir, 'pkg', 'store.py'), `from pkg.base import Base, top_level\n\ndef helper():\n    return top_level()\n\nclass Store(Base):\n    def load(self):\n        return helper()\n`);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('extracts module/class/function/method symbols', async () => {
    const { symbols } = await extractRepo(dir, { repo: 'pyfix', langs: ['py'], now: T0 });
    const names = new Set(symbols.map((s) => `${s.symbolKind}:${s.name}`));
    assert.ok(names.has('class:Base'), 'Base class');
    assert.ok(names.has('class:Store'), 'Store class');
    assert.ok(names.has('function:top_level'), 'top_level function');
    assert.ok(names.has('method:Base.greet'), 'Base.greet method');
    assert.ok(names.has('method:Store.load'), 'Store.load method');
  });

  it('emits IMPORTS (store→base) and EXTENDS (Store→Base)', async () => {
    const { edges } = await extractRepo(dir, { repo: 'pyfix', langs: ['py'], now: T0 });
    assert.ok(
      edges.some((e) => e.kind === 'IMPORTS' && e.src === symbolId('pyfix', 'pkg/store.py', '<module>') && e.dst === symbolId('pyfix', 'pkg/base.py', '<module>')),
      `expected store→base IMPORTS, got ${JSON.stringify(edges.filter((e) => e.kind === 'IMPORTS'))}`,
    );
    assert.ok(
      edges.some((e) => e.kind === 'EXTENDS' && e.src === symbolId('pyfix', 'pkg/store.py', 'Store') && e.dst === symbolId('pyfix', 'pkg/base.py', 'Base')),
      `expected Store→Base EXTENDS, got ${JSON.stringify(edges.filter((e) => e.kind === 'EXTENDS'))}`,
    );
  });

  it('emits CALLS edges (cross-import + method→func) with no dangling targets', async () => {
    const { symbols, edges } = await extractRepo(dir, { repo: 'pyfix', langs: ['py'], now: T0 });
    const calls = edges.filter((e) => e.kind === 'CALLS');
    const sid = (file: string, name: string) => symbolId('pyfix', file, name);

    // cross-import: helper() calls top_level() imported from pkg.base
    assert.ok(
      calls.some((e) => e.src === sid('pkg/store.py', 'helper') && e.dst === sid('pkg/base.py', 'top_level')),
      `expected helper→base.top_level CALLS, got ${JSON.stringify(calls)}`,
    );
    // intra-file method → top-level function: Store.load() calls helper()
    assert.ok(
      calls.some((e) => e.src === sid('pkg/store.py', 'Store.load') && e.dst === sid('pkg/store.py', 'helper')),
      `expected Store.load→helper CALLS, got ${JSON.stringify(calls)}`,
    );

    const ids = new Set(symbols.map((s) => s.id));
    for (const e of calls) {
      assert.ok(ids.has(e.src), `dangling CALLS src ${e.src}`);
      assert.ok(ids.has(e.dst), `dangling CALLS dst ${e.dst}`);
    }
  });
});

describe('extractRepo end-to-end into the store', () => {
  it('feeds a JsonSnapshotStore so dependents() answers the blast-radius query', async () => {
    const { JsonSnapshotStore } = await import('../../server/codegraph/adapters/json-snapshot.ts');
    const dir = mkdtempSync(join(tmpdir(), 'cg-e2e-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'shared.ts'), `export const shared = 1;\n`);
      writeFileSync(join(dir, 'src', 'a.ts'), `import { shared } from './shared.ts';\nexport const a = shared;\n`);
      writeFileSync(join(dir, 'src', 'b.ts'), `import { shared } from './shared.ts';\nexport const b = shared;\n`);
      const result = await extractRepo(dir, { repo: 'e2e', langs: ['ts'], now: T0 });
      const store = new JsonSnapshotStore();
      await store.upsert(result, { now: T0 });
      const dependents = await store.dependents(symbolId('e2e', 'src/shared.ts', '<module>'), ['IMPORTS']);
      const files = dependents.map((d) => d.file).sort();
      assert.deepEqual(files, ['src/a.ts', 'src/b.ts'], 'shared.ts is imported by a.ts and b.ts — the blast radius');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
