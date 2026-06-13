/**
 * Extraction dispatcher + repo walker.
 *
 * extractRepo() walks a repo, routes files to the TS or Python extractor by
 * extension, and merges the results into one ExtractResult. This is the entry
 * point both consumers use: the swarm-runtime (per-worktree, into a
 * JsonSnapshotStore) and dev-time (incremental, into the Cortex graph via API).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractResult, Lang } from '../types.ts';
import { extractTypeScript } from './typescript.ts';
import { extractPython } from './python.ts';

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const PY_EXT = new Set(['.py']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', 'venv']);

export interface ExtractOpts {
  repo: string;
  /** Restrict to these languages. Default: both. */
  langs?: Lang[];
  /** Epoch ms stamped onto new symbols' lifecycle. */
  now: number;
}

export async function extractRepo(repoRoot: string, opts: ExtractOpts): Promise<ExtractResult> {
  const langs = new Set(opts.langs ?? (['ts', 'py'] as Lang[]));
  const tsFiles: string[] = [];
  const pyFiles: string[] = [];

  for (const abs of walk(repoRoot)) {
    const dot = abs.lastIndexOf('.');
    const ext = dot >= 0 ? abs.slice(dot) : '';
    if (langs.has('ts') && TS_EXT.has(ext) && !abs.endsWith('.d.ts')) tsFiles.push(abs);
    else if (langs.has('py') && PY_EXT.has(ext)) pyFiles.push(abs);
  }

  const results: ExtractResult[] = [];
  if (tsFiles.length) results.push(extractTypeScript(tsFiles, { repo: opts.repo, repoRoot, now: opts.now }));
  if (pyFiles.length) results.push(await extractPython(pyFiles, { repo: opts.repo, repoRoot, now: opts.now }));

  return {
    symbols: results.flatMap((r) => r.symbols),
    edges: results.flatMap((r) => r.edges),
    // Preserve the abspath we walked, keyed by repo, so a downstream store can
    // persist it (Symbol.file is repo-relative and the root is otherwise lost).
    roots: { [opts.repo]: repoRoot },
  };
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(abs);
    else if (st.isFile()) yield abs;
  }
}
