/**
 * CodeGraphStore — the storage-agnostic contract.
 *
 * Adapters:
 *   - JsonSnapshotStore (this package)     — community default, per-repo JSON
 *   - CortexGraphStore (claude-config-dashboard, future) — folds Symbol nodes
 *       into the singular Cortex graph + cross-links to Memory nodes
 *   - NoopStore        (feature disabled)
 *
 * Selected by CODE_GRAPH=off|json|cortex. The community build defaults to off
 * so it stays self-contained (no singular-Cortex graph backend). See
 * /personal/docs/cortex-code-graph.md.
 *
 * The load-bearing query is `dependents()` — the blast-radius lookup that
 * retires the scope-reconciler oscillation bug: at dispatch the swarm asks
 * "who else imports/calls this symbol?" and widens touches:* accordingly,
 * instead of relying on a worker to remember transitive deps.
 */
import type { Edge, ExtractResult, SymbolNode } from './types.ts';

export interface ForgetResult {
  archived: string[];
}

export interface CodeGraphStore {
  /**
   * Merge an extraction pass into the graph. Existing symbols are updated
   * (preserving their lifecycle); symbols that were present before but absent
   * from this result for the same (repo, file set) are marked
   * groundTruthValid=false — the provable-staleness signal.
   */
  upsert(result: ExtractResult, opts: { now: number; reExtractedRepo?: string }): Promise<void>;

  /** Symbols that depend ON this one (incoming edges) — the blast radius. */
  dependents(symbolId: string, edgeKinds?: Edge['kind'][]): Promise<SymbolNode[]>;

  /** Symbols this one depends on (outgoing edges). */
  dependencies(symbolId: string, edgeKinds?: Edge['kind'][]): Promise<SymbolNode[]>;

  /** Reinforce a node (it was accessed/touched). Bumps relevance + lastSeen. */
  recordAccess(symbolId: string, now: number): Promise<void>;

  /** Recompute stickiness from in-degree centrality across the whole graph. */
  recomputeCentrality(now: number): Promise<void>;

  /** Soft-archive nodes below the relevance threshold (and any ground-truth-invalid). */
  forgetBelow(threshold: number, now: number): Promise<ForgetResult>;

  pin(symbolId: string): Promise<void>;
  unpin(symbolId: string): Promise<void>;

  get(symbolId: string): Promise<SymbolNode | null>;
  all(): Promise<SymbolNode[]>;
}
