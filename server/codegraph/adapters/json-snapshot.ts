/**
 * JsonSnapshotStore — the reference CodeGraphStore adapter and community default.
 *
 * In-memory symbol/edge maps with optional JSON persistence to a file. No
 * external dependency. Recursive blast-radius queries are plain BFS over the
 * edge set. This is the adapter the swarm-runtime consumer uses first; the
 * CortexGraphStore adapter (singular-mind integration) implements the same
 * interface later.
 *
 * Persistence is explicit (load()/save()) so callers control when IO happens
 * — important inside a worktree dispatch where the snapshot may be ephemeral.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CodeGraphStore, ForgetResult } from '../store.ts';
import type { Edge, ExtractResult, SymbolNode } from '../types.ts';
import {
  decayedRelevance,
  reinforce,
  pin as pinLc,
  unpin as unpinLc,
  invalidateGroundTruth,
  centralityStickiness,
  shouldForget,
} from '../lifecycle.ts';

interface Snapshot {
  symbols: SymbolNode[];
  edges: Edge[];
  archived: string[];
}

export class JsonSnapshotStore implements CodeGraphStore {
  private symbols = new Map<string, SymbolNode>();
  private edges: Edge[] = [];
  private archived = new Set<string>();
  private readonly path?: string;

  constructor(opts: { path?: string } = {}) {
    this.path = opts.path;
    if (this.path && existsSync(this.path)) this.load();
  }

  load(): void {
    if (!this.path || !existsSync(this.path)) return;
    const snap = JSON.parse(readFileSync(this.path, 'utf8')) as Snapshot;
    this.symbols = new Map(snap.symbols.map((s) => [s.id, s]));
    this.edges = snap.edges;
    this.archived = new Set(snap.archived ?? []);
  }

  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const snap: Snapshot = {
      symbols: [...this.symbols.values()],
      edges: this.edges,
      archived: [...this.archived],
    };
    writeFileSync(this.path, JSON.stringify(snap, null, 2), 'utf8');
  }

  async upsert(result: ExtractResult, opts: { now: number; reExtractedRepo?: string }): Promise<void> {
    const seen = new Set<string>();
    for (const incoming of result.symbols) {
      seen.add(incoming.id);
      const existing = this.symbols.get(incoming.id);
      if (existing) {
        // Preserve lifecycle; refresh structural fields + re-validate ground truth.
        this.symbols.set(incoming.id, {
          ...incoming,
          lifecycle: { ...existing.lifecycle, groundTruthValid: true },
        });
      } else {
        this.symbols.set(incoming.id, incoming);
      }
      this.archived.delete(incoming.id);
    }

    // Provable staleness: a symbol previously known in a re-extracted repo but
    // absent from this pass has left the source tree. Mark it, don't delete —
    // the sweep archives it; its edges stay as history.
    if (opts.reExtractedRepo) {
      for (const [id, node] of this.symbols) {
        if (node.repo === opts.reExtractedRepo && !seen.has(id)) {
          node.lifecycle = invalidateGroundTruth(node.lifecycle);
        }
      }
    }

    // Replace edges originating from the re-extracted symbols (idempotent upsert).
    const incomingSrcs = new Set(result.symbols.map((s) => s.id));
    this.edges = this.edges.filter((e) => !incomingSrcs.has(e.src)).concat(result.edges);
  }

  async dependents(symbolId: string, edgeKinds?: Edge['kind'][]): Promise<SymbolNode[]> {
    const kinds = edgeKinds ? new Set(edgeKinds) : null;
    const srcIds = this.edges
      .filter((e) => e.dst === symbolId && (!kinds || kinds.has(e.kind)))
      .map((e) => e.src);
    return this.resolve(srcIds);
  }

  async dependencies(symbolId: string, edgeKinds?: Edge['kind'][]): Promise<SymbolNode[]> {
    const kinds = edgeKinds ? new Set(edgeKinds) : null;
    const dstIds = this.edges
      .filter((e) => e.src === symbolId && (!kinds || kinds.has(e.kind)))
      .map((e) => e.dst);
    return this.resolve(dstIds);
  }

  async recordAccess(symbolId: string, now: number): Promise<void> {
    const node = this.symbols.get(symbolId);
    if (!node) return;
    node.lifecycle = reinforce(node.lifecycle, now, 0.1);
  }

  async recomputeCentrality(_now: number): Promise<void> {
    const inDegree = new Map<string, number>();
    for (const e of this.edges) {
      inDegree.set(e.dst, (inDegree.get(e.dst) ?? 0) + 1);
    }
    for (const [id, node] of this.symbols) {
      if (node.lifecycle.pinned) continue;
      const centrality = centralityStickiness(inDegree.get(id) ?? 0);
      // Centrality sets a FLOOR on stickiness; reinforcement can raise it higher.
      if (centrality > node.lifecycle.stickiness) {
        node.lifecycle = { ...node.lifecycle, stickiness: centrality };
      }
    }
  }

  async forgetBelow(threshold: number, now: number): Promise<ForgetResult> {
    const archived: string[] = [];
    for (const [id, node] of this.symbols) {
      if (shouldForget(node.lifecycle, now, threshold)) {
        this.archived.add(id);
        this.symbols.delete(id);
        archived.push(id);
        // Edges are intentionally retained as history.
      }
    }
    return { archived };
  }

  async pin(symbolId: string): Promise<void> {
    const node = this.symbols.get(symbolId);
    if (node) node.lifecycle = pinLc(node.lifecycle);
  }

  async unpin(symbolId: string): Promise<void> {
    const node = this.symbols.get(symbolId);
    if (node) node.lifecycle = unpinLc(node.lifecycle);
  }

  async get(symbolId: string): Promise<SymbolNode | null> {
    return this.symbols.get(symbolId) ?? null;
  }

  async all(): Promise<SymbolNode[]> {
    return [...this.symbols.values()];
  }

  /** Test/introspection helper: current relevance of a node. */
  relevanceOf(symbolId: string, now: number): number | null {
    const node = this.symbols.get(symbolId);
    return node ? decayedRelevance(node.lifecycle, now) : null;
  }

  isArchived(symbolId: string): boolean {
    return this.archived.has(symbolId);
  }

  private resolve(ids: string[]): SymbolNode[] {
    const out: SymbolNode[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const node = this.symbols.get(id);
      if (node) out.push(node);
    }
    return out;
  }
}
