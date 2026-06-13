/**
 * Python extractor (web-tree-sitter + tree-sitter-wasms grammar).
 *
 * tree-sitter does no symbol resolution, so edges are name/path-based and
 * best-effort — good enough for the blast-radius use case (who imports this
 * module). Symbols: module, top-level functions, classes, methods. Edges:
 * IMPORTS (resolved to in-repo files heuristically), EXTENDS (class bases by
 * name, matched to an in-repo class), CALLS (heuristic).
 *
 * CALLS coverage (v2, best-effort — no type system):
 *   - intra-file: a `call` to a bare name that matches a top-level
 *     function/class defined in the SAME file → edge to that symbol.
 *   - cross-file: a `call` to a name that was `from mod import name`-ed from an
 *     in-repo module which defines that top-level function/class → edge to it.
 * Deliberately NOT handled (would be guessy → dangling): method calls
 * (`obj.foo()`), `module.func()` attribute calls, names shadowed by locals.
 * A missed edge is preferred over a wrong one. The enclosing symbol of a call
 * is the nearest top-level function / class-method that contains it.
 *
 * wasm path is the community-portability choice: no native build toolchain
 * needed when a community user flips CODE_GRAPH on.
 */
import { readFileSync } from 'node:fs';
import { relative, dirname } from 'node:path';
import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import { symbolId, newLifecycle, type Edge, type ExtractResult, type SymbolNode, type SymbolKind } from '../types.ts';

const MODULE_NAME = '<module>';
const require = createRequire(import.meta.url);

// web-tree-sitter 0.24.x API: default export is the Parser class with a static
// init(); Parser.Language is available after init. (Pinned to 0.24 because the
// tree-sitter-wasms 0.1.x grammars target that ABI; 0.25+ can't load them.)
let langPromise: Promise<Parser.Language> | null = null;
async function pythonLanguage(): Promise<Parser.Language> {
  if (!langPromise) {
    langPromise = (async () => {
      await Parser.init();
      const pkg = require.resolve('tree-sitter-wasms/package.json');
      const wasm = `${dirname(pkg)}/out/tree-sitter-python.wasm`;
      return Parser.Language.load(wasm);
    })();
  }
  return langPromise;
}

export async function extractPython(
  absFiles: string[],
  opts: { repo: string; repoRoot: string; now: number },
): Promise<ExtractResult> {
  const lang = await pythonLanguage();
  const parser = new Parser();
  parser.setLanguage(lang);

  const symbols: SymbolNode[] = [];
  const edges: Edge[] = [];
  const known = new Set<string>();
  const relFiles = new Set(absFiles.map((f) => relative(opts.repoRoot, f)));
  // class name → defining rel file, for EXTENDS resolution
  const classIndex = new Map<string, string>();
  // per-file set of top-level def/class names (the call-resolvable targets).
  const topLevelDefs = new Map<string, Set<string>>();

  const add = (s: SymbolNode) => {
    if (known.has(s.id)) return;
    known.add(s.id);
    symbols.push(s);
  };
  const mk = (file: string, name: string, kind: SymbolKind, line: number): SymbolNode => ({
    id: symbolId(opts.repo, file, name),
    kind: 'symbol',
    name,
    symbolKind: kind,
    repo: opts.repo,
    file,
    lang: 'py',
    line,
    lifecycle: newLifecycle(opts.now),
  });
  // Module node: keep the id fragment as MODULE_NAME (IMPORTS edges link to it),
  // but use the file path as the display name instead of the literal "<module>".
  const mkModule = (file: string): SymbolNode => ({ ...mk(file, MODULE_NAME, 'module', 1), name: file });

  // First pass: symbols + class index.
  const parsed: Array<{ file: string; root: Parser.Tree | null }> = [];
  for (const abs of absFiles) {
    const file = relative(opts.repoRoot, abs);
    let src: string;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const tree = parser.parse(src);
    parsed.push({ file, root: tree });
    add(mkModule(file));
    const root = tree?.rootNode;
    if (!root) continue;
    const defs = new Set<string>();
    topLevelDefs.set(file, defs);

    for (const node of root.namedChildren) {
      if (!node) continue;
      if (node.type === 'function_definition') {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          add(mk(file, name, 'function', node.startPosition.row + 1));
          defs.add(name);
        }
      } else if (node.type === 'class_definition') {
        const name = node.childForFieldName('name')?.text;
        if (!name) continue;
        add(mk(file, name, 'class', node.startPosition.row + 1));
        classIndex.set(name, file);
        defs.add(name);
        // methods: function_definition inside the class body block
        const body = node.childForFieldName('body');
        for (const m of body?.namedChildren ?? []) {
          if (m?.type === 'function_definition') {
            const mn = m.childForFieldName('name')?.text;
            if (mn) add(mk(file, `${name}.${mn}`, 'method', m.startPosition.row + 1));
          }
        }
      }
    }
  }

  // Second pass: edges (needs the full classIndex + relFiles for resolution).
  for (const { file, root } of parsed) {
    const r = root?.rootNode;
    if (!r) continue;
    const moduleId = symbolId(opts.repo, file, MODULE_NAME);
    // imported name → in-repo file that defines it as a top-level def/class.
    // Built here per-file, consumed by the CALLS sub-pass below.
    const importedNames = new Map<string, string>();

    for (const node of r.namedChildren) {
      if (!node) continue;
      if (node.type === 'import_statement' || node.type === 'import_from_statement') {
        const moduleName = node.childForFieldName('module_name')?.text
          ?? node.namedChildren.find((c) => c?.type === 'dotted_name')?.text;
        const targetFile = resolvePyModule(moduleName, relFiles);
        if (targetFile) {
          add(mkModule(targetFile));
          edges.push({ src: moduleId, dst: symbolId(opts.repo, targetFile, MODULE_NAME), kind: 'IMPORTS' });
          // `from mod import name [as alias]` — record name→targetFile when the
          // target file actually defines that top-level symbol (else dangling).
          if (node.type === 'import_from_statement') {
            const targetDefs = topLevelDefs.get(targetFile);
            for (const { local, imported } of importedNamesOf(node)) {
              if (targetDefs?.has(imported)) importedNames.set(local, targetFile);
            }
          }
        }
      } else if (node.type === 'class_definition') {
        const clsName = node.childForFieldName('name')?.text;
        const superclasses = node.childForFieldName('superclasses');
        if (clsName && superclasses) {
          for (const base of superclasses.namedChildren) {
            const baseName = base?.text;
            if (!baseName) continue;
            const baseFile = classIndex.get(baseName);
            if (baseFile) {
              edges.push({
                src: symbolId(opts.repo, file, clsName),
                dst: symbolId(opts.repo, baseFile, baseName),
                kind: 'EXTENDS',
              });
            }
          }
        }
      }
    }

    // CALLS sub-pass for this file: walk each top-level function and each
    // class-method body, attributing `call` nodes to the enclosing symbol.
    const localDefs = topLevelDefs.get(file) ?? new Set<string>();
    const resolveCallee = (name: string): string | null => {
      if (localDefs.has(name)) return symbolId(opts.repo, file, name);
      const tf = importedNames.get(name);
      if (tf) return symbolId(opts.repo, tf, name);
      return null;
    };
    const emitCalls = (srcId: string, bodyNode: Parser.SyntaxNode | null) => {
      if (!bodyNode) return;
      for (const call of descendantCalls(bodyNode)) {
        const fn = call.childForFieldName('function');
        // only bare-identifier callees (`foo()`); attribute/method calls skipped
        if (!fn || fn.type !== 'identifier') continue;
        const dst = resolveCallee(fn.text);
        if (dst && dst !== srcId) edges.push({ src: srcId, dst, kind: 'CALLS' });
      }
    };
    for (const node of r.namedChildren) {
      if (!node) continue;
      if (node.type === 'function_definition') {
        const name = node.childForFieldName('name')?.text;
        if (name) emitCalls(symbolId(opts.repo, file, name), node.childForFieldName('body'));
      } else if (node.type === 'class_definition') {
        const clsName = node.childForFieldName('name')?.text;
        const body = node.childForFieldName('body');
        if (!clsName || !body) continue;
        for (const m of body.namedChildren) {
          if (m?.type !== 'function_definition') continue;
          const mn = m.childForFieldName('name')?.text;
          if (mn) emitCalls(symbolId(opts.repo, file, `${clsName}.${mn}`), m.childForFieldName('body'));
        }
      }
    }
  }

  return { symbols, edges: dedupeEdges(edges) };
}

/** Imported (local, imported-source) name pairs from a `from … import …` node. */
function importedNamesOf(node: Parser.SyntaxNode): Array<{ local: string; imported: string }> {
  const out: Array<{ local: string; imported: string }> = [];
  const moduleNameNode = node.childForFieldName('module_name');
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'dotted_name' || child.type === 'identifier') {
      // module_name is also a dotted_name; skip it — imported names follow.
      if (child === moduleNameNode) continue;
      const name = child.text;
      if (name) out.push({ local: name, imported: name });
    } else if (child.type === 'aliased_import') {
      const orig = child.childForFieldName('name')?.text;
      const alias = child.childForFieldName('alias')?.text;
      if (orig && alias) out.push({ local: alias, imported: orig });
    }
  }
  return out;
}

/** All `call` nodes under a subtree (recursive; tree-sitter has no helper). */
function descendantCalls(root: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    for (const c of n.namedChildren) {
      if (!c) continue;
      if (c.type === 'call') out.push(c);
      stack.push(c);
    }
  }
  return out;
}

/** Map a dotted python module ("pkg.mod") to an in-repo rel file, best-effort. */
function resolvePyModule(moduleName: string | undefined, relFiles: ReadonlySet<string>): string | null {
  if (!moduleName) return null;
  const base = moduleName.replace(/^\.+/, '').replace(/\./g, '/');
  for (const cand of [`${base}.py`, `${base}/__init__.py`]) {
    if (relFiles.has(cand)) return cand;
    for (const f of relFiles) if (f.endsWith(`/${cand}`)) return f;
  }
  return null;
}

function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const e of edges) {
    const k = `${e.src}|${e.dst}|${e.kind}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
