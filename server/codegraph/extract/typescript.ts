/**
 * TypeScript/JS extractor (ts-morph).
 *
 * Produces module + declaration symbols and the dependency edges that matter
 * for the blast-radius query: IMPORTS (intra-repo, the import-closure that
 * retires the scope-reconciler oscillation), plus EXTENDS/IMPLEMENTS.
 *
 * v1 deliberately resolves edges only to IN-REPO targets — external packages
 * (react, etc.) are not graphed; we care about cross-ticket internal coupling.
 * IMPORTS at module granularity already matches what the touches-gate enforces.
 *
 * CALLS edges (added in v2) give function/method/class symbols call-graph
 * coupling so they participate in centrality, not just module IMPORTS. We use
 * the ts-morph type-checker to resolve each callee to its DECLARATION node, then
 * only emit an edge when (a) the declaration lives inside the repo and (b) the
 * resolved name matches a symbol we actually extract — so edges never dangle.
 * Noise control is conservative: unresolved callees, externals/built-ins, and
 * callees that don't map to an emitted symbol are silently skipped (a missed
 * edge is preferable to a wrong one). See resolveCallTarget() for the rules.
 */
import { relative } from 'node:path';
import { Node, Project, SyntaxKind, type SourceFile } from 'ts-morph';
import { symbolId, newLifecycle, type Edge, type ExtractResult, type SymbolNode, type SymbolKind } from '../types.ts';

const MODULE_NAME = '<module>';

export function extractTypeScript(
  absFiles: string[],
  opts: { repo: string; repoRoot: string; now: number },
): ExtractResult {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, checkJs: false, noEmit: true },
  });
  for (const f of absFiles) project.addSourceFileAtPathIfExists(f);

  const symbols: SymbolNode[] = [];
  const edges: Edge[] = [];
  const known = new Set<string>();
  // Declarations with a body, paired with the symbol id they belong to. Calls
  // are resolved in a second pass once `known` holds every emitted symbol id,
  // so CALLS edges can be filtered to non-dangling targets only.
  const bodied: Array<{ srcId: string; node: Node }> = [];

  const add = (s: SymbolNode) => {
    if (known.has(s.id)) return;
    known.add(s.id);
    symbols.push(s);
  };
  const rel = (sf: SourceFile) => relative(opts.repoRoot, sf.getFilePath());
  const mk = (file: string, name: string, kind: SymbolKind, line: number): SymbolNode => ({
    id: symbolId(opts.repo, file, name),
    kind: 'symbol',
    name,
    symbolKind: kind,
    repo: opts.repo,
    file,
    lang: 'ts',
    line,
    lifecycle: newLifecycle(opts.now),
  });
  // Module node: keep the id fragment as MODULE_NAME (IMPORTS edges link to it),
  // but use the file path as the display name so it reads as the file, not the
  // literal "<module>".
  const mkModule = (file: string): SymbolNode => ({ ...mk(file, MODULE_NAME, 'module', 1), name: file });

  for (const sf of project.getSourceFiles()) {
    const file = rel(sf);
    const moduleSym = mkModule(file);
    add(moduleSym);

    for (const fn of sf.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      add(mk(file, name, 'function', fn.getStartLineNumber()));
      bodied.push({ srcId: symbolId(opts.repo, file, name), node: fn });
    }
    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (!name) continue;
      const clsSym = mk(file, name, 'class', cls.getStartLineNumber());
      add(clsSym);
      for (const m of cls.getMethods()) {
        const methodName = `${name}.${m.getName()}`;
        add(mk(file, methodName, 'method', m.getStartLineNumber()));
        bodied.push({ srcId: symbolId(opts.repo, file, methodName), node: m });
      }
      // EXTENDS / IMPLEMENTS — resolve heritage via the file's imports.
      const ext = cls.getExtends();
      if (ext) {
        const target = resolveHeritage(sf, ext.getExpression().getText(), opts);
        if (target) edges.push({ src: clsSym.id, dst: target, kind: 'EXTENDS' });
      }
      for (const impl of cls.getImplements()) {
        const target = resolveHeritage(sf, impl.getExpression().getText(), opts);
        if (target) edges.push({ src: clsSym.id, dst: target, kind: 'IMPLEMENTS' });
      }
    }
    for (const iface of sf.getInterfaces()) {
      add(mk(file, iface.getName(), 'interface', iface.getStartLineNumber()));
    }
    for (const ta of sf.getTypeAliases()) {
      add(mk(file, ta.getName(), 'type', ta.getStartLineNumber()));
    }
    for (const en of sf.getEnums()) {
      add(mk(file, en.getName(), 'enum', en.getStartLineNumber()));
    }
    // Exported const arrow-functions / values.
    for (const vd of sf.getVariableDeclarations()) {
      if (!vd.isExported()) continue;
      const arrow = vd.getInitializerIfKind(SyntaxKind.ArrowFunction);
      add(mk(file, vd.getName(), arrow ? 'function' : 'variable', vd.getStartLineNumber()));
      if (arrow) bodied.push({ srcId: symbolId(opts.repo, file, vd.getName()), node: arrow });
    }

    // IMPORTS — module→module, in-repo targets only.
    for (const imp of sf.getImportDeclarations()) {
      const targetSf = imp.getModuleSpecifierSourceFile();
      if (!targetSf) continue; // unresolved or external
      if (targetSf.getFilePath().includes('node_modules')) continue;
      const targetFile = rel(targetSf);
      if (targetFile.startsWith('..')) continue; // outside the repo root
      // ensure the target module node exists even if it had no declarations yet
      add(mkModule(targetFile));
      edges.push({
        src: moduleSym.id,
        dst: symbolId(opts.repo, targetFile, MODULE_NAME),
        kind: 'IMPORTS',
      });
    }
  }

  // CALLS — second pass: now that `known` holds every emitted symbol id, walk
  // each bodied declaration's CallExpressions and resolve callees to in-repo
  // declarations. Only emit when the resolved dst is a symbol we actually
  // extracted (in `known`), so no edge ever dangles.
  for (const { srcId, node } of bodied) {
    for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const dst = resolveCallTarget(call.getExpression(), opts, known);
      if (dst && dst !== srcId) edges.push({ src: srcId, dst, kind: 'CALLS' });
    }
  }

  return { symbols, edges: dedupeEdges(edges) };
}

/**
 * Resolve a call's callee expression to an in-repo symbol id, or null.
 *
 * Handles two callee shapes:
 *   - bare identifier `foo()`         → resolves to a function/class decl
 *   - property access `obj.method()`  → resolves to a method decl
 * Other shapes (element access, computed, IIFE, etc.) are skipped.
 *
 * Resolution goes through the type-checker via getSymbol()/getAliasedSymbol(),
 * then inspects the declaration node to recover its source file + the name the
 * extractor would have stamped (plain name for functions/classes/arrow consts,
 * `Class.method` for methods). The candidate id is returned ONLY if it is in
 * `known` (an emitted symbol) and the declaration lives inside the repo — this
 * is what keeps the call graph free of external/built-in and dangling edges.
 */
function resolveCallTarget(
  callee: Node,
  opts: { repo: string; repoRoot: string },
  known: ReadonlySet<string>,
): string | null {
  let nameNode: Node | undefined;
  if (Node.isIdentifier(callee)) {
    nameNode = callee;
  } else if (Node.isPropertyAccessExpression(callee)) {
    nameNode = callee.getNameNode();
  } else {
    return null;
  }
  if (!nameNode) return null;

  let sym = nameNode.getSymbol();
  if (!sym) return null;
  const aliased = sym.getAliasedSymbol?.();
  if (aliased) sym = aliased;

  for (const decl of sym.getDeclarations()) {
    const id = declToSymbolId(decl, opts);
    if (id && known.has(id)) return id;
  }
  return null;
}

/** Map a declaration node to the symbol id the extractor stamps for it, or null. */
function declToSymbolId(decl: Node, opts: { repo: string; repoRoot: string }): string | null {
  const declFile = relative(opts.repoRoot, decl.getSourceFile().getFilePath());
  if (declFile.startsWith('..') || decl.getSourceFile().getFilePath().includes('node_modules')) return null;

  // function declaration / class declaration → bare name
  if (Node.isFunctionDeclaration(decl) || Node.isClassDeclaration(decl)) {
    const n = decl.getName();
    return n ? symbolId(opts.repo, declFile, n) : null;
  }
  // method → Class.method (only when nested in a named class)
  if (Node.isMethodDeclaration(decl)) {
    const cls = decl.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const clsName = cls?.getName();
    const mName = decl.getName();
    return clsName && mName ? symbolId(opts.repo, declFile, `${clsName}.${mName}`) : null;
  }
  // exported `const foo = () => …` → variable declaration whose name is the symbol
  if (Node.isVariableDeclaration(decl)) {
    return symbolId(opts.repo, declFile, decl.getName());
  }
  return null;
}

/**
 * Resolve a heritage name (e.g. `Base` in `extends Base`) to an in-repo symbol
 * id. Uses the file's own import declarations rather than the type checker —
 * the in-memory project doesn't reliably resolve aliased symbols, but
 * `getModuleSpecifierSourceFile()` (the same path IMPORTS uses) is reliable.
 *
 * Resolution order: a declaration local to this file, then a named/default
 * import pointing at an in-repo module. Qualified names (`ns.Base`) are reduced
 * to their final segment. Returns null for externals or unresolved names.
 */
function resolveHeritage(sf: SourceFile, rawName: string, opts: { repo: string; repoRoot: string }): string | null {
  const name = rawName.includes('.') ? rawName.slice(rawName.lastIndexOf('.') + 1) : rawName;
  const thisFile = relative(opts.repoRoot, sf.getFilePath());

  // Declared locally in this file?
  if (sf.getClass(name) || sf.getInterface(name)) {
    return symbolId(opts.repo, thisFile, name);
  }

  // Imported from an in-repo module?
  for (const imp of sf.getImportDeclarations()) {
    const named = imp.getNamedImports().map((n) => n.getName());
    const def = imp.getDefaultImport()?.getText();
    if (!named.includes(name) && def !== name) continue;
    const tsf = imp.getModuleSpecifierSourceFile();
    if (!tsf || tsf.getFilePath().includes('node_modules')) continue;
    const file = relative(opts.repoRoot, tsf.getFilePath());
    if (file.startsWith('..')) continue;
    return symbolId(opts.repo, file, name);
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
