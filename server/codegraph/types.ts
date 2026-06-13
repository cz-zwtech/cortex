/**
 * Core node/edge types for the code graph.
 *
 * The graph is designed to live INSIDE the singular Cortex graph (SQLite) as an
 * extension — `Symbol` nodes alongside `Memory` nodes — but every type here is
 * storage-agnostic so the JSON reference adapter and a community no-op adapter
 * can implement the same contract. See /personal/docs/cortex-code-graph.md.
 */

export type Lang = 'ts' | 'py';

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'module'
  | 'variable'
  | 'enum';

export type EdgeKind =
  | 'CALLS'
  | 'IMPORTS'
  | 'EXTENDS'
  | 'IMPLEMENTS'
  | 'REFERENCES';

/**
 * The forgetting-lifecycle fields carried by EVERY graph node (symbols here;
 * memories carry the same shape in the Cortex graph). Decay + stickiness +
 * staleness are computed by src/lifecycle.ts from these fields.
 *
 * `groundTruthValid` is the asymmetry that makes code nodes special: a symbol
 * is provably stale the moment re-extraction can't find it in source, whereas
 * a memory's staleness is only ever estimated from time + contradiction.
 * `undefined` means "not a ground-truthable node" (i.e. a memory).
 */
export interface Lifecycle {
  /** Relevance ceiling, reset to 1 on reinforcement. */
  base: number;
  /** 0..1 resistance to decay. Pinned/central nodes ≈ 1. */
  stickiness: number;
  /** Epoch ms of last access/reinforcement. */
  lastSeen: number;
  /** User- or system-pinned: never auto-forgotten regardless of decay. */
  pinned: boolean;
  /** Code nodes only: does the symbol still exist in source? */
  groundTruthValid?: boolean;
}

export interface SymbolNode {
  /** Stable id: `${repo}:${file}#${name}` (see symbolId()). */
  id: string;
  kind: 'symbol';
  name: string;
  symbolKind: SymbolKind;
  repo: string;
  /** Repo-relative path. */
  file: string;
  lang: Lang;
  line: number;
  signature?: string;
  lifecycle: Lifecycle;
}

export interface Edge {
  src: string; // SymbolNode.id
  dst: string; // SymbolNode.id
  kind: EdgeKind;
}

export interface ExtractResult {
  symbols: SymbolNode[];
  edges: Edge[];
  /**
   * Per-repo absolute filesystem root the extraction walked. The root is used
   * to read files and is otherwise discarded — Symbol.file is repo-relative —
   * so this map is the only place the on-disk path survives. Lets a consumer
   * (e.g. the Cortex Code page) resolve a repo-relative file back to a real
   * path. Keyed by repo name; per-repo, never per-symbol.
   */
  roots?: Record<string, string>;
}

/** Deterministic id so re-extraction upserts the same node. */
export function symbolId(repo: string, file: string, name: string): string {
  return `${repo}:${file}#${name}`;
}

/** Fresh lifecycle for a newly-discovered symbol. */
export function newLifecycle(now: number): Lifecycle {
  return { base: 1, stickiness: 0, lastSeen: now, pinned: false, groundTruthValid: true };
}
