/**
 * The memory store — the one canonical write path.
 *
 * EVERY ingest source goes through `upsert`. Not a convention: the single
 * biggest silent defect in V1 exists precisely because one writer
 * (`seedOnboardingLocal`) hand-rolled an `INSERT INTO entries` and thereby
 * skipped embedding — leaving the entire onboarding corpus, the material that
 * teaches Claude how to operate Cortex, invisible to semantic recall: none of
 * those entries embedded, while comparable scopes were mostly or fully embedded.
 *
 * The class of defect is: *any writer that bypasses the canonical upsert
 * silently loses every downstream pass.* The architecture should make a second
 * such writer impossible rather than rely on nobody adding one. That is why
 * there is exactly one door here, and why derivation and notification hang off
 * it rather than being called alongside it.
 */

import type Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import type { Rule, RuleFields } from './rules.js'
import { createHash } from 'node:crypto'
import type {
  Memory,
  Hub,
  DeclaredEdge,
  ObservedEdge,
  DerivedEdge,
  Shape,
  Authorship,
  HubKind,
} from './types.js'

export type MemoryInput = Omit<Memory, 'contentHash' | 'ingestedAt'> & {
  contentHash?: string
  /**
   * Hash of the JOURNAL record this row derives from — the pointer that lets a
   * derived view address its own source. Absent for rows adopted from a peer,
   * which have no local durable record to point at.
   */
  journalHash?: string
  ingestedAt?: number
}

export type UpsertOutcome = {
  id: string
  /** 'created' | 'updated' | 'unchanged' — callers report this; silence is wrong. */
  result: 'created' | 'updated' | 'unchanged'
}

const bool = (n: number) => n === 1
const num = (b: boolean) => (b ? 1 : 0)

export const hashContent = (name: string, description: string, content: string): string =>
  createHash('sha256').update(`${name}\n${description}\n${content}`).digest('hex')

export class MemoryStore {
  #db: Database.Database

  constructor(db: Database.Database) {
    this.#db = db
  }

  /** Apply the module's schema. Idempotent — every statement is IF NOT EXISTS. */
  static applySchema(db: Database.Database, schemaPath?: string): void {
    const file = schemaPath ?? path.join(import.meta.dirname, '..', 'schema.sql')
    db.exec(fs.readFileSync(file, 'utf-8'))
  }

  // ── subjects: people and titles memories state (entities.ts) ──────────────

  /** Memories whose subject rows are missing, stale, or from an older extractor. */
  staleSubjects(version: number, limit: number): Memory[] {
    const rows = this.#db
      .prepare(
        `SELECT m.* FROM memories m LEFT JOIN subject_index s ON s.memory_id = m.id
         WHERE m.authorship != 'extracted' AND (s.memory_id IS NULL OR s.content_hash != m.content_hash OR s.version < ?)
         LIMIT ?`,
      )
      .all(version, limit) as Record<string, unknown>[]
    return rows.map((r) => this.#toMemory(r))
  }

  setSubjects(
    m: Pick<Memory, 'id' | 'contentHash'>,
    version: number,
    people: { name: string; title: string; roles: string[] }[],
    constraints: { text: string; keys: string[] }[] = [],
  ): void {
    this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM people WHERE memory_id = ?').run(m.id)
      const put = this.#db.prepare('INSERT OR IGNORE INTO people (memory_id, name, title, roles) VALUES (?,?,?,?)')
      for (const p of people) put.run(m.id, p.name, p.title, p.roles.join(' '))
      this.#db.prepare('DELETE FROM constraint_lines WHERE memory_id = ?').run(m.id)
      const line = this.#db.prepare('INSERT INTO constraint_lines (memory_id, ord, text, keys) VALUES (?,?,?,?)')
      constraints.forEach((c, i) => line.run(m.id, i, c.text, c.keys.join(' ')))
      this.#db
        .prepare('INSERT INTO subject_index (memory_id, content_hash, version) VALUES (?,?,?) ON CONFLICT(memory_id) DO UPDATE SET content_hash=excluded.content_hash, version=excluded.version')
        .run(m.id, m.contentHash, version)
    })()
  }

  /** Subject rows of memories that no longer exist. */
  pruneSubjects(): number {
    const a =
      this.#db.prepare('DELETE FROM people WHERE memory_id NOT IN (SELECT id FROM memories)').run().changes +
      this.#db.prepare('DELETE FROM constraint_lines WHERE memory_id NOT IN (SELECT id FROM memories)').run().changes
    const b = this.#db.prepare('DELETE FROM subject_index WHERE memory_id NOT IN (SELECT id FROM memories)').run().changes
    return a + b
  }

  /** Every constraint line, with what the privacy rules need of its memory. */
  constraintLines(): { memoryId: string; ord: number; text: string; keys: string[]; name: string; scope: string; source: string; authoredAt: number }[] {
    return (
      this.#db
        .prepare(
          `SELECT c.memory_id, c.ord, c.text, c.keys, m.name, m.scope, m.source, m.authored_at
           FROM constraint_lines c JOIN memories m ON m.id = c.memory_id`,
        )
        .all() as { memory_id: string; ord: number; text: string; keys: string; name: string; scope: string; source: string; authored_at: number }[]
    ).map((r) => ({ memoryId: r.memory_id, ord: r.ord, text: r.text, keys: r.keys.split(' ').filter(Boolean), name: r.name, scope: r.scope, source: r.source, authoredAt: r.authored_at }))
  }

  /** Every word of every known person's name, lower-case: what makes a name key strong (constraints.ts gate). */
  peopleTokens(): Set<string> {
    const out = new Set<string>()
    for (const r of this.#db.prepare('SELECT DISTINCT name FROM people').all() as { name: string }[])
      for (const w of r.name.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3) out.add(w)
    return out
  }

  /** People holding any of these role keys, with the memory that says so. */
  peopleWithRoles(keys: string[]): { memoryId: string; name: string; title: string }[] {
    if (!keys.length) return []
    const like = keys.map(() => "(' ' || roles || ' ') LIKE ?").join(' OR ')
    return (
      this.#db.prepare(`SELECT memory_id, name, title FROM people WHERE ${like}`).all(...keys.map((k) => `% ${k} %`)) as {
        memory_id: string
        name: string
        title: string
      }[]
    ).map((r) => ({ memoryId: r.memory_id, name: r.name, title: r.title }))
  }

  // ── memories ───────────────────────────────────────────────────────────────

  /**
   * The canonical write. Returns what actually happened so callers can report
   * it — a pass that mutates the user's graph silently is the wrong default.
   *
   * Unchanged content is a genuine no-op: it does NOT touch declared edges, so
   * re-ingesting an untouched file cannot disturb anything downstream.
   */
  upsert(input: MemoryInput): UpsertOutcome {
    const contentHash =
      input.contentHash ?? hashContent(input.name, input.description, input.content)
    const now = input.ingestedAt ?? Date.now()

    const existing = this.#db
      .prepare<[string], { content_hash: string }>('SELECT content_hash FROM memories WHERE id = ?')
      .get(input.id)

    if (existing?.content_hash === contentHash) return { id: input.id, result: 'unchanged' }

    this.#db
      .prepare(
        `INSERT INTO memories
           (id, source, journal_hash, name, description, content, shape, authorship, scope,
            pinned, protected, content_hash, machine, authored_at, ingested_at,
            outcome, outcome_text)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           source=excluded.source, journal_hash=excluded.journal_hash,
           name=excluded.name, description=excluded.description,
           content=excluded.content, shape=excluded.shape, authorship=excluded.authorship,
           scope=excluded.scope,
           -- Ingest can raise these flags, never clear them: they are also set by hand (standing, protect),
           -- and a re-ingest of the same memory must not undo that.
           pinned=MAX(memories.pinned, excluded.pinned), protected=MAX(memories.protected, excluded.protected),
           content_hash=excluded.content_hash, machine=excluded.machine,
           authored_at=excluded.authored_at, ingested_at=excluded.ingested_at,
           outcome=excluded.outcome, outcome_text=excluded.outcome_text`,
      )
      .run(
        input.id,
        input.source,
        input.journalHash ?? null,
        input.name,
        input.description,
        input.content,
        input.shape,
        input.authorship,
        input.scope,
        num(input.pinned),
        num(input.protected),
        contentHash,
        input.machine,
        input.authoredAt,
        now,
        input.outcome,
        input.outcomeText,
      )

    return { id: input.id, result: existing ? 'updated' : 'created' }
  }

  get(id: string): Memory | null {
    const row = this.#db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.#toMemory(row) : null
  }

  /**
   * ⚠ IDENTITY-BY-PATH IS DEAD under the first-class-memory charter.
   *
   * `source` remains PROVENANCE (where this came from) but is no longer
   * IDENTITY. A memory `.md` becomes a write-inbox that empties on ingest, so
   * the path is a mailbox rather than an address: the next write to the same
   * path is a different memory, and there is nothing left to update in place.
   *
   * This lookup stays for provenance queries. It must NOT be used to decide
   * whether an incoming memory already exists — that is the reconcile ladder,
   * which matches on a declared slug and falls back to content, because a
   * session that never read our instructions declares no slug and is still
   * required to be safe.
   *
   * RETURNS A LIST, not a single memory. One mailbox legitimately yields many
   * memories over time, and the singular signature was the dead assumption
   * encoded in the type.
   */
  bySource(source: string): Memory[] {
    const rows = this.#db
      .prepare('SELECT * FROM memories WHERE source = ? ORDER BY ingested_at')
      .all(source) as Record<string, unknown>[]
    return rows.map((r) => this.#toMemory(r))
  }

  /**
   * The memory claiming this slug in this scope, if any.
   *
   * The slug is frontmatter `name:` — this corpus already writes one-fact
   * memories under kebab-case slugs, so no new column is needed. It is a
   * MATCHING SIGNAL, never a key: a slug match is a question for the reconcile
   * ladder, which decides whether it means "update" or "two memories".
   *
   * Scoped, because two projects may legitimately both hold `deploy-process`.
   *
   * RETURNS N, and N is routinely greater than one. `name` carries no uniqueness
   * constraint, and rungs 1c and 1x DELIBERATELY create same-slug/same-scope
   * pairs — that is what "keep both" means. A scalar signature would have been
   * correct only until the ladder created its first pair, after which every
   * later same-slug write would silently match an arbitrary member.
   */
  /** Every memory with this name, in any scope (the standing seed matches old index lines by file name). */
  byName(name: string): Memory[] {
    return (this.#db.prepare('SELECT * FROM memories WHERE name = ? ORDER BY ingested_at').all(name) as Record<string, unknown>[]).map((r) => this.#toMemory(r))
  }

  bySlug(scope: string, slug: string): Memory[] {
    const rows = this.#db
      .prepare('SELECT * FROM memories WHERE scope = ? AND name = ? ORDER BY ingested_at')
      .all(scope, slug) as Record<string, unknown>[]
    return rows.map((r) => this.#toMemory(r))
  }

  /**
   * Resolve an id through settlement aliases.
   *
   * Consulted BEFORE any id-declaring write is honoured. Without it, a write
   * against an id that lost a settle resurrects the node that was settled away.
   */
  resolveId(id: string): string {
    const row = this.#db
      .prepare<[string], { canonical_id: string }>(
        'SELECT canonical_id FROM id_aliases WHERE alias_id = ?',
      )
      .get(id)
    return row?.canonical_id ?? id
  }

  /** Record a settlement: `aliasId` resolves forward to `canonicalId` forever. */
  settle(aliasId: string, canonicalId: string, at = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO id_aliases (alias_id, canonical_id, settled_at) VALUES (?,?,?)
         ON CONFLICT(alias_id) DO UPDATE SET canonical_id=excluded.canonical_id, settled_at=excluded.settled_at`,
      )
      .run(aliasId, canonicalId, at)
  }

  /**
   * Delete a memory and everything anchored to it.
   *
   * Deliberately removes DECLARED and DERIVED edges owned by this memory while
   * leaving OBSERVED edges to be cleaned separately — see `deleteCascade`. The
   * split exists so a caller cannot destroy surfacing history by accident.
   */
  delete(id: string): boolean {
    const info = this.#db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    if (info.changes === 0) return false
    this.#db.prepare('DELETE FROM rules WHERE id = ?').run(id)
    this.#db.prepare('DELETE FROM declared_edges WHERE src = ? OR dst = ?').run(id, id)
    this.#db.prepare('DELETE FROM derived_edges WHERE src = ? OR dst = ?').run(id, id)
    this.#db.prepare('DELETE FROM people WHERE memory_id = ?').run(id)
    this.#db.prepare('DELETE FROM constraint_lines WHERE memory_id = ?').run(id)
    this.#db.prepare('DELETE FROM subject_index WHERE memory_id = ?').run(id)
    return true
  }

  /** Delete including observed edges. Explicit, because it discards history. */
  deleteCascade(id: string): boolean {
    const deleted = this.delete(id)
    if (deleted) {
      this.#db.prepare('DELETE FROM observed_edges WHERE src = ? OR dst = ?').run(id, id)
    }
    return deleted
  }

  /** Standing: loaded at every session start, ahead of the ranked picks (the `pinned` column). */
  setStanding(id: string, value: boolean): boolean {
    return this.#db.prepare('UPDATE memories SET pinned = ? WHERE id = ?').run(num(value), id).changes > 0
  }

  standing(): Memory[] {
    return (this.#db.prepare('SELECT * FROM memories WHERE pinned = 1 ORDER BY name').all() as Record<string, unknown>[]).map((r) => this.#toMemory(r))
  }

  /** Set the generic decay-exemption flag. Other modules reach this via a capability. */
  setProtected(id: string, value: boolean): boolean {
    return this.#db.prepare('UPDATE memories SET protected = ? WHERE id = ?').run(num(value), id)
      .changes > 0
  }

  search(term: string, limit = 20): Memory[] {
    const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    const rows = this.#db
      .prepare(
        `SELECT * FROM memories
         WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
         ORDER BY authored_at DESC LIMIT ?`,
      )
      .all(like, like, like, limit) as Record<string, unknown>[]
    return rows.map((r) => this.#toMemory(r))
  }

  /**
   * Candidates for a multi-term query, best match first.
   *
   * `search` orders by recency and the seed used to stop after the first term's
   * `limit` hits, so in a real corpus the candidates were simply the newest
   * memories that mentioned the first word, and an older exact match was never
   * scored at all (laptop Stage A: "globex admins role" never reached
   * globex-admins-role). Here every memory matching ANY term competes: more
   * (IDF-weighted) terms first, then where they matched (name over description over
   * body), then recency. Extracted text (session checkpoints) is not a memory
   * anyone wrote and is never a candidate.
   */
  searchTerms(terms: string[], limit: number): Memory[] {
    if (!terms.length) return []
    const likes = terms.map((t) => `%${t.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)
    const where = likes.map(() => "(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')").join(' OR ')
    // Memories filed under a facet whose term matches are candidates too: a query by concern finds them.
    const facetLike = likes.map(() => "h.name LIKE ? ESCAPE '\\'").join(' OR ')
    const rows = this.#db
      .prepare(
        `SELECT * FROM memories WHERE authorship != 'extracted' AND ((${where}) OR id IN (
           SELECT e.src FROM derived_edges e JOIN hubs h ON h.id = e.dst
           WHERE h.kind = 'facet' AND e.rel IN ('focus','about') AND (${facetLike})))`,
      )
      .all(...likes.flatMap((l) => [l, l, l]), ...likes.map((l) => l.replace(/-/g, '_').replace(/ /g, '-'))) as Record<string, unknown>[]

    const n = Math.max(1, this.count())
    const idf = new Map(terms.map((t) => [t, Math.log(1 + n / (1 + this.documentFrequency(t)))]))
    const scored = rows.map((r) => {
      const m = this.#toMemory(r)
      const name = m.name.toLowerCase()
      const desc = `${m.description} ${this.facetTermsOf(m.id).join(' ')}`.toLowerCase()
      const body = m.content.toLowerCase()
      let matched = 0
      let where = 0
      for (const t of terms) {
        const w = idf.get(t)!
        const inName = name.includes(t)
        const inDesc = desc.includes(t)
        if (inName || inDesc || body.includes(t)) matched += w
        where += w * (inName ? 3 : inDesc ? 2 : body.includes(t) ? 1 : 0)
      }
      return { m, rank: matched * 10 + where }
    })
    scored.sort((a, b) => b.rank - a.rank || b.m.authoredAt - a.m.authoredAt)
    return scored.slice(0, limit).map((x) => x.m)
  }

  /** How many recallable memories mention this term anywhere. For IDF. */
  documentFrequency(term: string): number {
    const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    return (
      this.#db
        .prepare(
          `SELECT count(*) c FROM memories WHERE authorship != 'extracted'
           AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`,
        )
        .get(like, like, like) as { c: number }
    ).c
  }

  /** Memories recall can return: everything but extracted text. */
  countRecallable(): number {
    return (
      this.#db.prepare("SELECT count(*) c FROM memories WHERE authorship != 'extracted'").get() as { c: number }
    ).c
  }

  count(): number {
    return (this.#db.prepare('SELECT count(*) c FROM memories').get() as { c: number }).c
  }

  /**
   * The most recently authored memories in a scope — the dedupe comparison set.
   *
   * Bounded on purpose: the write-time reflex runs inside a hook budget, so it
   * compares against a window rather than the corpus. `search` cannot serve this
   * because it is a LIKE over a term, and the reflex has no term — it has a
   * whole pending memory and needs candidates to compare it WITH.
   *
   * The caller is expected to notice when the window was full and say so. A
   * bound that silently reduces coverage reads to the consumer as "nothing
   * matched", which is the one thing it does not mean.
   */
  recent(scope: string, limit: number): Memory[] {
    const rows = this.#db
      .prepare('SELECT * FROM memories WHERE scope = ? ORDER BY authored_at DESC LIMIT ?')
      .all(scope, limit) as Record<string, unknown>[]
    return rows.map((r) => this.#toMemory(r))
  }

  /** Every memory. For whole-corpus maintenance (reindex), never for recall. */
  all(): Memory[] {
    return (this.#db.prepare('SELECT * FROM memories').all() as Record<string, unknown>[]).map((r) =>
      this.#toMemory(r),
    )
  }

  /**
   * Set the two fields ingest derives from frontmatter.
   *
   * Not `upsert`: its unchanged-check hashes name, description and body, so a
   * shape-only correction would be reported unchanged and silently skipped.
   */
  setDerived(id: string, description: string, shape: Memory['shape'], authorship: Memory['authorship']): void {
    const row = this.get(id)
    if (!row) return
    this.#db
      .prepare('UPDATE memories SET description = ?, shape = ?, authorship = ?, content_hash = ? WHERE id = ?')
      .run(description, shape, authorship, hashContent(row.name, description, row.content), id)
  }

  // ── hubs ───────────────────────────────────────────────────────────────────

  upsertHub(hub: Hub): void {
    this.#db
      .prepare(
        `INSERT INTO hubs (id, kind, name) VALUES (?,?,?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name`,
      )
      .run(hub.id, hub.kind, hub.name)
  }

  getHub(id: string): Hub | null {
    const row = this.#db.prepare('SELECT * FROM hubs WHERE id = ?').get(id) as
      | { id: string; kind: string; name: string }
      | undefined
    return row ? { id: row.id, kind: row.kind as HubKind, name: row.name } : null
  }

  // ── edges, by lifetime ─────────────────────────────────────────────────────

  /**
   * Replace the declared edges of one source.
   *
   * Safe to wipe-and-rebuild precisely BECAUSE declared edges live in their own
   * table: nothing else writes here, so there is no carve-out list to maintain
   * and no observational history to lose. That was V1's most-guarded invariant
   * — four separate tests — and here it is structural instead.
   */
  setDeclaredEdges(src: string, edges: DeclaredEdge[]): void {
    const tx = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM declared_edges WHERE src = ?').run(src)
      const ins = this.#db.prepare(
        'INSERT OR REPLACE INTO declared_edges (src, dst, rel, label) VALUES (?,?,?,?)',
      )
      for (const e of edges) ins.run(e.src, e.dst, e.rel, e.label ?? '')
    })
    tx()
  }

  declaredEdges(src: string): DeclaredEdge[] {
    return this.#db.prepare('SELECT * FROM declared_edges WHERE src = ?').all(src) as DeclaredEdge[]
  }

  inboundDeclared(dst: string): DeclaredEdge[] {
    return this.#db.prepare('SELECT * FROM declared_edges WHERE dst = ?').all(dst) as DeclaredEdge[]
  }

  /** Record an observation. Repeats increment rather than duplicating. */
  observe(src: string, dst: string, rel: ObservedEdge['rel'], at = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO observed_edges (src, dst, rel, count, first_at, last_at)
         VALUES (?,?,?,1,?,?)
         ON CONFLICT(src, dst, rel) DO UPDATE SET
           count = count + 1, last_at = excluded.last_at`,
      )
      .run(src, dst, rel, at, at)
  }

  /** Edges INTO a hub (a session): which memories it showed, used or wrote, newest first. */
  observedInto(dst: string, rels: ObservedEdge['rel'][]): ObservedEdge[] {
    if (!rels.length) return []
    const rows = this.#db
      .prepare(`SELECT * FROM observed_edges WHERE dst = ? AND rel IN (${rels.map(() => '?').join(',')}) ORDER BY last_at DESC`)
      .all(dst, ...rels) as Record<string, unknown>[]
    return rows.map((r) => ({
      src: r.src as string,
      dst: r.dst as string,
      rel: r.rel as ObservedEdge['rel'],
      count: r.count as number,
      firstAt: r.first_at as number,
      lastAt: r.last_at as number,
    }))
  }

  observedEdges(src: string): ObservedEdge[] {
    const rows = this.#db.prepare('SELECT * FROM observed_edges WHERE src = ?').all(src) as Record<
      string,
      unknown
    >[]
    return rows.map((r) => ({
      src: r.src as string,
      dst: r.dst as string,
      rel: r.rel as ObservedEdge['rel'],
      count: r.count as number,
      firstAt: r.first_at as number,
      lastAt: r.last_at as number,
    }))
  }

  setDerivedEdges(src: string, edges: DerivedEdge[], at = Date.now()): void {
    const tx = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM derived_edges WHERE src = ?').run(src)
      const ins = this.#db.prepare(
        'INSERT OR REPLACE INTO derived_edges (src, dst, rel, score, computed_at) VALUES (?,?,?,?,?)',
      )
      for (const e of edges) ins.run(e.src, e.dst, e.rel, e.score, at)
    })
    tx()
  }

  /** Add one derived edge without touching the others (setDerivedEdges replaces them all). */
  addDerivedEdge(e: DerivedEdge, at = Date.now()): void {
    this.#db.prepare('INSERT OR REPLACE INTO derived_edges (src, dst, rel, score, computed_at) VALUES (?,?,?,?,?)').run(e.src, e.dst, e.rel, e.score, at)
  }

  /** Derived edges that point AT a node: how a facet hub reaches its memories. */
  derivedInto(dst: string, rels?: DerivedEdge['rel'][]): DerivedEdge[] {
    const rows = this.#db.prepare('SELECT * FROM derived_edges WHERE dst = ?').all(dst) as Record<string, unknown>[]
    return rows
      .map((r) => ({ src: r.src as string, dst: r.dst as string, rel: r.rel as DerivedEdge['rel'], score: r.score as number }))
      .filter((e) => !rels || rels.includes(e.rel))
  }

  /** The words of a memory's facet terms (`inter-service-communication` gives `inter service communication`). */
  facetTermsOf(id: string): string[] {
    return (
      this.#db
        .prepare("SELECT h.name FROM derived_edges e JOIN hubs h ON h.id = e.dst WHERE e.src = ? AND e.rel IN ('focus','about') AND h.kind = 'facet'")
        .all(id) as { name: string }[]
    ).map((r) => r.name.slice(r.name.indexOf(':') + 1).replace(/-/g, ' '))
  }

  hubsOfKind(kind: Hub['kind']): Hub[] {
    return (this.#db.prepare('SELECT * FROM hubs WHERE kind = ? ORDER BY name').all(kind) as Hub[])
  }

  /** Recall-able memories with no facet yet: what the next consolidation batch takes. */
  withoutFacets(limit: number): Memory[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM memories m WHERE authorship != 'extracted'
         AND NOT EXISTS (SELECT 1 FROM derived_edges e WHERE e.src = m.id AND e.rel = 'focus')
         ORDER BY ingested_at LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[]
    return rows.map((r) => this.#toMemory(r))
  }

  // ── consolidation runs: every change a run makes is recorded, so the run can be reverted whole ──

  beginRun(r: { run: string; at: number; stage: string; model: string; effort?: string }): void {
    this.#db.prepare("INSERT INTO consolidation_runs (run, at, stage, model, effort, status) VALUES (?,?,?,?,?,'running')").run(r.run, r.at, r.stage, r.model, r.effort ?? null)
  }

  endRun(run: string, f: { batches: number; ops: number; rejected: number; tokens: number; costUsd: number; status: string; note?: string }): void {
    this.#db
      .prepare('UPDATE consolidation_runs SET batches = ?, ops = ?, rejected = ?, tokens = ?, cost_usd = ?, status = ?, note = ? WHERE run = ?')
      .run(f.batches, f.ops, f.rejected, f.tokens, f.costUsd, f.status, f.note ?? null, run)
  }

  recordOp(run: string, kind: 'hub' | 'edge', a: string, b = '', rel = ''): void {
    this.#db.prepare('INSERT OR IGNORE INTO consolidation_ops (run, kind, a, b, rel) VALUES (?,?,?,?,?)').run(run, kind, a, b, rel)
  }

  runs(limit = 20): { run: string; at: number; stage: string; model: string; effort: string | null; batches: number; ops: number; rejected: number; tokens: number; cost_usd: number; status: string; note: string | null }[] {
    return this.#db.prepare('SELECT * FROM consolidation_runs ORDER BY at DESC LIMIT ?').all(limit) as never
  }

  /** Tokens spent by consolidation since a time: the daily cap reads this. */
  tokensSince(at: number): number {
    return (this.#db.prepare('SELECT COALESCE(SUM(tokens), 0) t FROM consolidation_runs WHERE at >= ?').get(at) as { t: number }).t
  }

  /**
   * Undo one run. What it added goes (edges; hubs unless something else uses
   * them; flags; checks), and what it removed comes back (edges and hubs a
   * vocabulary merge moved or retired). Memories it wrote are returned for the
   * caller to tombstone through the journal.
   */
  revertRun(run: string): { edges: number; hubs: number; restored: number; memories: string[] } {
    let edges = 0
    let hubs = 0
    let restored = 0
    const memories: string[] = []
    this.#db.transaction(() => {
      const ops = this.#db.prepare('SELECT * FROM consolidation_ops WHERE run = ?').all(run) as { kind: string; a: string; b: string; rel: string }[]
      for (const o of ops.filter((x) => x.kind === 'edge')) {
        edges += this.#db.prepare('DELETE FROM derived_edges WHERE src = ? AND dst = ? AND rel = ?').run(o.a, o.b, o.rel).changes
      }
      for (const o of ops.filter((x) => x.kind === 'hub-removed')) {
        restored += this.#db.prepare("INSERT OR IGNORE INTO hubs (id, kind, name) VALUES (?, 'facet', ?)").run(o.a, o.b).changes
      }
      for (const o of ops.filter((x) => x.kind === 'edge-removed')) {
        restored += this.#db.prepare('INSERT OR IGNORE INTO derived_edges (src, dst, rel, score, computed_at) VALUES (?,?,?,1,?)').run(o.a, o.b, o.rel, Date.now()).changes
      }
      for (const o of ops.filter((x) => x.kind === 'hub')) {
        const used = this.#db.prepare('SELECT 1 FROM derived_edges WHERE src = ? OR dst = ? LIMIT 1').get(o.a, o.a)
        if (!used) hubs += this.#db.prepare('DELETE FROM hubs WHERE id = ?').run(o.a).changes
      }
      for (const o of ops.filter((x) => x.kind === 'memory')) memories.push(o.a)
      this.#db.prepare('DELETE FROM staleness WHERE run = ?').run(run)
      this.#db.prepare('DELETE FROM relation_checks WHERE run = ?').run(run)
      this.#db.prepare("UPDATE consolidation_runs SET status = 'reverted' WHERE run = ?").run(run)
    })()
    return { edges, hubs, restored, memories }
  }

  recordOpKind(run: string, kind: 'edge-removed' | 'hub-removed' | 'memory', a: string, b = '', rel = ''): void {
    this.#db.prepare('INSERT OR IGNORE INTO consolidation_ops (run, kind, a, b, rel) VALUES (?,?,?,?,?)').run(run, kind, a, b, rel)
  }

  removeDerivedEdge(src: string, dst: string, rel: string): boolean {
    return this.#db.prepare('DELETE FROM derived_edges WHERE src = ? AND dst = ? AND rel = ?').run(src, dst, rel).changes > 0
  }

  removeHub(id: string): boolean {
    return this.#db.prepare('DELETE FROM hubs WHERE id = ?').run(id).changes > 0
  }

  /** Memory pairs that share a facet and have not been judged yet: what a relations batch takes. */
  unjudgedPairs(limit: number, perHub = 25): [Memory, Memory][] {
    const out: [Memory, Memory][] = []
    const seen = new Set<string>()
    const hubs = this.#db.prepare("SELECT id FROM hubs WHERE kind = 'facet'").all() as { id: string }[]
    const members = this.#db.prepare("SELECT src FROM derived_edges WHERE dst = ? AND rel IN ('focus','about') ORDER BY src LIMIT ?")
    const judged = this.#db.prepare('SELECT 1 FROM relation_checks WHERE a = ? AND b = ?')
    for (const h of hubs) {
      const ids = (members.all(h.id, perHub) as { src: string }[]).map((r) => r.src)
      for (let i = 0; i < ids.length && out.length < limit; i++) {
        for (let j = i + 1; j < ids.length && out.length < limit; j++) {
          const [a, b] = [ids[i]!, ids[j]!].sort() as [string, string]
          const key = `${a}|${b}`
          if (seen.has(key) || judged.get(a, b)) continue
          seen.add(key)
          const ma = this.get(a)
          const mb = this.get(b)
          if (ma && mb) out.push([ma, mb])
        }
      }
      if (out.length >= limit) break
    }
    return out
  }

  judged(a: string, b: string, relation: string, run: string, at = Date.now()): void {
    const [x, y] = [a, b].sort()
    this.#db.prepare('INSERT OR REPLACE INTO relation_checks (a, b, relation, run, at) VALUES (?,?,?,?,?)').run(x, y, relation, run, at)
  }

  wasJudged(a: string, b: string): boolean {
    const [x, y] = [a, b].sort()
    return !!this.#db.prepare('SELECT 1 FROM relation_checks WHERE a = ? AND b = ?').get(x, y)
  }

  flag(memory: string, reason: 'contradicted' | 'condition-lapsed' | 'unconfirmed', detail: string, run: string, at = Date.now()): boolean {
    return this.#db.prepare('INSERT OR IGNORE INTO staleness (memory, reason, since, detail, run) VALUES (?,?,?,?,?)').run(memory, reason, at, detail, run).changes > 0
  }

  flags(memory?: string): { memory: string; reason: string; since: number; detail: string | null; run: string | null }[] {
    return (memory
      ? this.#db.prepare('SELECT * FROM staleness WHERE memory = ? ORDER BY since').all(memory)
      : this.#db.prepare('SELECT * FROM staleness ORDER BY since DESC').all()) as never
  }

  /** Facet hubs with no memory or spine edge left: what a vocabulary pass retires. */
  unusedFacets(): Hub[] {
    return this.#db
      .prepare("SELECT * FROM hubs h WHERE kind = 'facet' AND NOT EXISTS (SELECT 1 FROM derived_edges e WHERE e.dst = h.id OR e.src = h.id)")
      .all() as Hub[]
  }

  /** The last time a memory was shown to a session, if ever. */
  lastSurfaced(id: string): number | undefined {
    return (this.#db.prepare("SELECT MAX(last_at) t FROM observed_edges WHERE src = ? AND rel = 'surfaced_in'").get(id) as { t: number | null }).t ?? undefined
  }

  derivedEdges(src: string): DerivedEdge[] {
    const rows = this.#db.prepare('SELECT * FROM derived_edges WHERE src = ?').all(src) as Record<
      string,
      unknown
    >[]
    return rows.map((r) => ({
      src: r.src as string,
      dst: r.dst as string,
      rel: r.rel as DerivedEdge['rel'],
      score: r.score as number,
    }))
  }

  // ── hub garbage collection ─────────────────────────────────────────────────

  /**
   * Sweep orphaned hubs.
   *
   * Hubs never decay — decay is about RELEVANCE and a hub has none to lose. Hub
   * lifetime is a REFERENTIAL question: a hub whose last inbound edge is gone is
   * garbage regardless of age, and a hub with edges is live regardless of how
   * cold. So this is a reference sweep, not a decay pass.
   *
   * Memory owns it because hubs are memory's traversal structure — memory
   * creates them and is the only module that can see all three edge stores.
   *
   * Two safety properties, both deliberate:
   *
   *  1. EXPLICIT, never automatic. A sweep that ran on its own during ingest
   *     could race a half-written batch and delete a hub whose edge is about to
   *     arrive. Because the caller chooses the moment, no time-based floor is
   *     needed — an earlier draft of this method took a `notBefore` argument
   *     that did nothing on either branch, which is the same
   *     declared-but-inert defect this project keeps finding elsewhere. Removed
   *     rather than shipped.
   *  2. `dryRun`, so the destructive version is never the only way to find out
   *     what it would do.
   *
   * On modules being ABSENT: this only ever removes hubs with no reference in
   * ANY edge store. It cannot be tricked into deleting a hub that something
   * still points at, which is what would otherwise make toggling a module off
   * destroy state.
   */
  sweepOrphanHubs(opts: { dryRun?: boolean } = {}): { removed: string[]; kept: number } {
    const rows = this.#db
      .prepare(
        `SELECT h.id AS id FROM hubs h
         WHERE NOT EXISTS (SELECT 1 FROM declared_edges e WHERE e.src = h.id OR e.dst = h.id)
           AND NOT EXISTS (SELECT 1 FROM observed_edges e WHERE e.src = h.id OR e.dst = h.id)
           AND NOT EXISTS (SELECT 1 FROM derived_edges  e WHERE e.src = h.id OR e.dst = h.id)`,
      )
      .all() as { id: string }[]

    const candidates = rows.map((r) => r.id)
    const total = (this.#db.prepare('SELECT count(*) c FROM hubs').get() as { c: number }).c

    if (opts.dryRun) return { removed: candidates, kept: total - candidates.length }

    const tx = this.#db.transaction(() => {
      const del = this.#db.prepare('DELETE FROM hubs WHERE id = ?')
      for (const id of candidates) del.run(id)
    })
    tx()

    return { removed: candidates, kept: total - candidates.length }
  }

  // ── consume ledger ─────────────────────────────────────────────────────────

  /**
   * The memory this exact text already resolved to, or null if it is new.
   *
   * Keyed by the TEXT, not the mailbox, so re-running ingest is safe whichever
   * file the text arrives in. That is the whole of what this buys — it does NOT
   * catch a session re-saving the same fact in different words, because that
   * regenerates prose rather than replaying bytes.
   */
  /** The journal record this row derives from, when there is a local one. */
  journalHashOf(id: string): string | null {
    const row = this.#db
      .prepare<[string], { journal_hash: string | null }>(
        'SELECT journal_hash FROM memories WHERE id = ?',
      )
      .get(id)
    return row?.journal_hash ?? null
  }

  consumedAs(contentHash: string): string | null {
    const row = this.#db
      .prepare<[string], { memory_id: string }>(
        'SELECT memory_id FROM consume_ledger WHERE content_hash = ?',
      )
      .get(contentHash)
    return row?.memory_id ?? null
  }

  // ── rules ──────────────────────────────────────────────────────────────────

  /** A memory's rule fields, set at ingest; `null` clears them (it is no longer a rule). */
  setRule(id: string, fields: RuleFields | null): void {
    if (fields) this.#db.prepare('INSERT INTO rules (id, fields) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET fields = excluded.fields').run(id, JSON.stringify(fields))
    else this.#db.prepare('DELETE FROM rules WHERE id = ?').run(id)
  }

  /** Whether a [[link]] names a memory here: by front-matter name or by its file name. */
  hasMemoryNamed(link: string): boolean {
    return !!this.#db
      .prepare<[string, string], { id: string }>("SELECT id FROM memories WHERE name = ? OR source LIKE ? LIMIT 1")
      .get(link, `%/${link}.md`)
  }

  /** Every rule, with its memory's name. */
  rules(): Rule[] {
    const rows = this.#db
      .prepare<[], { id: string; name: string; fields: string; authored_at: number }>(
        'SELECT r.id, m.name, r.fields, m.authored_at FROM rules r JOIN memories m ON m.id = r.id ORDER BY m.name',
      )
      .all()
    return rows.map((r) => ({ id: r.id, name: r.name, ...(JSON.parse(r.fields) as RuleFields), since: r.authored_at }))
  }

  // ── quarantine ─────────────────────────────────────────────────────────────

  /**
   * Record that ingest DECLINED this mailbox. Stores findings, never content.
   *
   * The original stays in the scratchpad because consume does not run for a
   * declined memory — so there is nothing to copy, and copying it would create
   * a new place secrets live inside a database that gets interval backups.
   */
  quarantine(contentHash: string, source: string, findings: unknown, at = Date.now()): void {
    // Keyed by hash and idempotent: a scratchpad is re-scanned every sync cycle,
    // and unchanged content must not grow this table on every pass.
    this.#db
      .prepare(
        `INSERT INTO quarantine (content_hash, source, findings, seen_at) VALUES (?,?,?,?)
         ON CONFLICT(content_hash) DO UPDATE SET source=excluded.source, findings=excluded.findings`,
      )
      .run(contentHash, source, JSON.stringify(findings), at)
  }

  /** True when this exact text is currently declined. */
  isDeclined(contentHash: string): boolean {
    return !!this.#db
      .prepare('SELECT 1 FROM quarantine WHERE content_hash = ?')
      .get(contentHash)
  }

  /**
   * A human's override of a false positive. PER-HASH, so releasing one memory
   * never blanket-disables the scanner.
   *
   * This only clears the decline — the caller then pushes the content through
   * the ORDINARY ingest flow. A release that wrote straight to the graph would
   * make released memories the one class that never got reconciled.
   */
  release(contentHash: string, reason = '', at = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO quarantine_released (content_hash, released_at, reason) VALUES (?,?,?)
         ON CONFLICT(content_hash) DO NOTHING`,
      )
      .run(contentHash, at, reason)
    this.#db.prepare('DELETE FROM quarantine WHERE content_hash = ?').run(contentHash)
  }

  isReleased(contentHash: string): boolean {
    return !!this.#db
      .prepare('SELECT 1 FROM quarantine_released WHERE content_hash = ?')
      .get(contentHash)
  }

  // ── boot reconciliation ────────────────────────────────────────────────────

  /** The redaction epoch this graph has applied. 0 on a fresh or restored DB. */
  appliedRedactionEpoch(): number {
    const row = this.#db
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get('redaction_epoch')
    return row ? Number(row.value) : 0
  }

  setAppliedRedactionEpoch(epoch: number): void {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('redaction_epoch', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(String(epoch))
  }

  /**
   * Remove every memory whose stored content hashes to `contentHash`.
   *
   * Redactions address by hash rather than by id because an id is a graph
   * concept and a restored graph may hold the same content under a different
   * one — the content hash is what survives every generation.
   */
  /** Remove the graph rows derived from a journal record, by that record's hash. */
  deleteByJournalHash(journalHash: string): number {
    const ids = this.#db.prepare('SELECT id FROM memories WHERE journal_hash = ?').all(journalHash) as { id: string }[]
    return ids.filter(({ id }) => this.deleteCascade(id)).length
  }

  deleteByContentHash(contentHash: string): number {
    const ids = (
      this.#db.prepare('SELECT id FROM memories WHERE content_hash = ?').all(contentHash) as {
        id: string
      }[]
    ).map((r) => r.id)
    for (const id of ids) this.deleteCascade(id)
    return ids.length
  }

  /** Clear a decline because the text changed — the writer fixed it. */
  clearDecline(contentHash: string): boolean {
    return (
      this.#db.prepare('DELETE FROM quarantine WHERE content_hash = ?').run(contentHash).changes > 0
    )
  }

  /**
   * Everything currently held back.
   *
   * Surfaced in `status` because a growing backlog is the tell that the scanner
   * is too noisy — and a quarantine that stops being read turns false positives
   * into a SILENT RECALL GAP, which is the failure this architecture is least
   * able to detect on its own.
   */
  quarantined(): { hash: string; source: string; findings: unknown; seenAt: number }[] {
    return (
      this.#db.prepare('SELECT * FROM quarantine ORDER BY seen_at').all() as Record<
        string,
        unknown
      >[]
    ).map((r) => ({
      hash: r.content_hash as string,
      source: r.source as string,
      findings: JSON.parse(r.findings as string),
      seenAt: r.seen_at as number,
    }))
  }

  /**
   * Record a consume. `seen_count` counts RETRIES, not re-saves.
   *
   * BELT AND BRACES, and it fails loudly on purpose. Recording a consumption for
   * a hash with an open decline means something reached the consume path with
   * content the gate refused — and since quarantine deliberately keeps no copy,
   * the scratchpad is the ONLY copy. This is the tripwire for a bug the type
   * system cannot see, and it must stop the process rather than write a log line
   * nobody reads.
   */
  recordConsume(contentHash: string, memoryId: string, at = Date.now()): void {
    if (this.isDeclined(contentHash)) {
      throw new Error(
        `Refusing to record a consumption for declined content (${contentHash.slice(0, 12)}…). ` +
          'The scratchpad is the only copy of a declined memory. This is a bug in the caller, ' +
          'not a condition to handle.',
      )
    }
    this.#db
      .prepare(
        `INSERT INTO consume_ledger (content_hash, memory_id, first_seen_at, last_seen_at, seen_count)
         VALUES (?,?,?,?,1)
         ON CONFLICT(content_hash) DO UPDATE SET
           last_seen_at=excluded.last_seen_at,
           seen_count=consume_ledger.seen_count + 1`,
      )
      .run(contentHash, memoryId, at, at)
  }

  #toMemory(r: Record<string, unknown>): Memory {
    return {
      id: r.id as string,
      source: r.source as string,
      name: r.name as string,
      description: r.description as string,
      content: r.content as string,
      shape: r.shape as Shape,
      authorship: r.authorship as Authorship,
      scope: r.scope as string,
      pinned: bool(r.pinned as number),
      protected: bool(r.protected as number),
      contentHash: r.content_hash as string,
      machine: r.machine as string,
      authoredAt: r.authored_at as number,
      ingestedAt: r.ingested_at as number,
      outcome: r.outcome as string,
      outcomeText: r.outcome_text as string,
    }
  }
}
