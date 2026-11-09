/**
 * The ingest path — where the three pieces become one flow.
 *
 *   SCAN ──fail──> QUARANTINE (nothing appended, nothing consumed)
 *     │
 *   append to journal        ← durable; nothing past here can lose text
 *     │
 *   reconcile (the ladder)   ← decides what the DERIVED graph does
 *     │
 *   write graph node/edges
 *     │
 *   receipt (id AND slug)
 *     │
 *   consume the scratchpad   ← copy → diff → drop → re-read and compare
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORDERING CONSTRAINT, AND WHY IT IS THE ONLY EXCEPTION
 *
 * The journal append is unconditional for everything that clears the scan, and
 * THE SCAN IS THE ONLY STEP PERMITTED BEFORE IT. Reconcile, dedupe, embedding
 * and edges all happen strictly after, because past the append nothing can lose
 * text. The scan is the exception because the journal is precisely the thing you
 * cannot take content back out of — once a credential is appended and
 * replicated, everything after is damage limitation rather than prevention.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ENTRY POINTS, ONE LADDER, DIFFERENT GATES
 *
 * `ingest` is for LOCALLY AUTHORED text and its gate BLOCKS.
 * `adopt` is for REPLICATED segments and its gate only FLAGS.
 *
 * They are deliberately separate functions rather than one with a flag. If
 * adoption reused the blocking gate it would refuse peer content and break
 * replication convergence while protecting nothing — the content is already
 * durable at the origin. Prevention is a per-origin guarantee; cross-machine,
 * the remedy is redaction. A boolean parameter would have made that a
 * one-character mistake away.
 */

import { classify, type SessionInfo } from './classify.js'
import { bodyOf, type ConsumeTicket } from './consume.js'
import { hashContent, type Journal, type MemoryRecord } from './journal.js'
import { reconcile, type ReconcileDecision, type ReconcileDeps } from './reconcile.js'
import { ruleOf } from './rules.js'
import { frontmatterOf } from './frontmatter.js'
import { scanForSecrets, type SecretFinding } from '../../../core/secrets.js'
import type { MemoryStore } from './store.js'

export type IngestInput = {
  /** Full text as written, frontmatter included. */
  content: string
  /** Body only, for hashing and comparison — frontmatter stripped upstream. */
  body: string
  slug: string
  scope: string
  source: string
  machine: string
  authoredAt: number
  declaredId?: string
  sessionId?: string
}

/**
 * What the writer gets back.
 *
 * The receipt carries `id` AND `slug` as one unit, never `id` alone — that is a
 * contract rule, not a convention. Rung 0's first and cheapest corroboration is
 * slug agreement, and it is unavailable if half the pair is missing.
 */
export type Receipt = {
  id: string
  slug: string
  rung: string
  action: ReconcileDecision['action']
  note: string
  settleable?: boolean
}

export type IngestResult =
  | { status: 'quarantined'; findings: SecretFinding[]; ticket: null }
  | { status: 'ingested'; receipt: Receipt; record: MemoryRecord; ticket: ConsumeTicket }

export type IngestDeps = Omit<ReconcileDeps, 'store'> & {
  store: MemoryStore
  journal: Journal
  now?: () => number
  /** What kind of session wrote a memory (the context store knows), for its sync class. */
  sessionInfo?: (sessionId: string) => SessionInfo | undefined
  /** Told of every ingested memory, after it is in the journal and the graph. */
  onIngested?: (r: { id: string; record: MemoryRecord }) => void
}

/**
 * Ingest locally-authored text. The gate BLOCKS.
 */
export const ingest = (input: IngestInput, deps: IngestDeps): IngestResult => {
  const now = deps.now ?? Date.now
  const { store, journal } = deps

  // ── 1. The gate. Before the append, and it blocks. ────────────────────────
  const bodyHash = hashContent(input.body)

  const findings = store.isReleased(bodyHash) ? [] : scanForSecrets(input.content)
  if (findings.length) {
    // Record that we DECLINED — not what we declined. The original stays in the
    // scratchpad because consume does not run, so quarantine needs to copy
    // nothing. A holding pen that stored the text would create a new place
    // secrets live, in a database that gets interval backups, for a feature
    // whose purpose is to stop secrets spreading.
    // Keyed by HASH so a re-scan of unchanged content is idempotent, and so the
    // storage layer can refuse a consumption for declined content.
    store.quarantine(bodyHash, input.source, findings, now())
    return { status: 'quarantined', findings, ticket: null }
  }

  // Content that was held on an earlier pass and passes now (the gate was tuned,
  // or released) must leave the queue, or `status` keeps reporting it held.
  store.clearDecline(bodyHash)

  // ── 2. Append. Durable before anything below runs. ────────────────────────
  const record = journal.appendMemory({
    slug: input.slug,
    source: input.source,
    scope: input.scope,
    machine: input.machine,
    authoredAt: input.authoredAt,
    content: input.content,
    ...(input.sessionId ? { session: input.sessionId } : {}),
    syncClass: classify({
      content: input.content,
      scope: input.scope,
      shape: frontmatterOf(input.content).shape,
      ...(input.sessionId && deps.sessionInfo ? { session: deps.sessionInfo(input.sessionId) } : {}),
    }),
  })

  // ── 3. Reconcile — derived-graph decision only. ───────────────────────────
  const decision = reconcile(
    {
      declaredId: input.declaredId,
      slug: input.slug,
      scope: input.scope,
      content: input.body,
      contentHash: bodyHash,
      machine: input.machine,
      sessionId: input.sessionId,
      isRule: ruleOf(input.content) !== null,
    },
    deps,
  )

  // ── 4. Apply to the graph. ────────────────────────────────────────────────
  const id = applyDecision(decision, input, bodyHash, record.contentHash, deps, now)
  // Which session wrote it: what a compacted session gets back as its own decisions (restore.ts).
  if (input.sessionId) {
    try {
      store.upsertHub({ id: input.sessionId, kind: 'session', name: input.sessionId })
      store.observe(id, input.sessionId, 'edited_in', now())
    } catch {
      /* provenance only: never undoes an ingest */
    }
  }
  try {
    deps.onIngested?.({ id, record })
  } catch {
    /* a listener never undoes an ingest */
  }

  // ── 5. Receipt, then consume. ─────────────────────────────────────────────
  const receipt: Receipt = {
    id,
    slug: input.slug,
    rung: decision.rung,
    action: decision.action,
    note: decision.note,
    ...(decision.settleable ? { settleable: true } : {}),
  }

  // The TICKET, minted here and only here: this content reached the journal AND
  // the graph. Consume's entire authority to drop anything comes from it, which
  // is why it names hashes rather than the file — a path says "something here
  // was ingested", a hash says exactly what. One emission, two artifacts.
  const ticket: ConsumeTicket = { source: input.source, hashes: [bodyHash], mintedAt: now() }

  return { status: 'ingested', receipt, record, ticket }
}

const applyDecision = (
  decision: ReconcileDecision,
  input: IngestInput,
  bodyHash: string,
  /**
   * The journal record this graph row will derive from.
   *
   * Threaded explicitly rather than recomputed: the journal hashes the FULL text
   * including frontmatter, and the graph stores the body — so a caller who tried
   * to derive this from what the row holds would produce a hash that matches
   * nothing, silently. That is precisely how the first attempt at durable
   * deletion failed.
   */
  journalHash: string,
  deps: IngestDeps,
  now: () => number,
): string => {
  const { store } = deps

  const { description, shape, authorship, standing } = frontmatterOf(input.content)
  const write = (id: string) => {
    store.upsert({
      journalHash,
      id,
      source: input.source,
      name: input.slug,
      description,
      content: input.body,
      shape,
      authorship,
      scope: input.scope,
      pinned: standing,
      protected: false,
      machine: input.machine,
      authoredAt: input.authoredAt,
      ingestedAt: now(),
      outcome: '',
      outcomeText: '',
    } as never)
    store.setRule(id, ruleOf(input.content))
    store.recordConsume(bodyHash, id, now())
    return id
  }

  switch (decision.action) {
    case 'update':
      return write(decision.target!)

    case 'fold': {
      // A fold ADDS provenance rather than discarding it. Without this, the
      // same fact saved in two projects keeps only the first scope and ranks
      // down in the second forever, with nothing recording it was ever
      // relevant there.
      const target = decision.target!
      const existing = store.get(target)
      if (existing && existing.scope !== input.scope) {
        store.upsertHub({ id: `scope:${input.scope}`, kind: 'session', name: input.scope })
        store.observe(target, `scope:${input.scope}`, 'also_ingested_in', now())
      }
      store.recordConsume(bodyHash, target, now())
      return target
    }

    case 'link': {
      // Keep BOTH. The link is what makes the pair settleable later, and the
      // observed store is where it belongs: it records a real event and must
      // survive re-ingest exactly as surfacing history must.
      const id = newId(input, bodyHash)
      write(id)
      store.observe(id, decision.target!, 'concurrent_with', now())
      store.observe(decision.target!, id, 'concurrent_with', now())
      return id
    }

    case 'create':
      return write(newId(input, bodyHash))
  }
}

/** Content-derived so a retried ingest of the same text produces the same node. */
const newId = (input: IngestInput, bodyHash: string): string =>
  `${input.slug || 'mem'}-${bodyHash.slice(0, 12)}`

export type AdoptReport = {
  /** Records kept, of every kind. */
  added: number
  /** Records refused: malformed, or a memory whose text no longer matches its hash. */
  rejected: number
  /** Graph ids the adopted memories became. */
  materialized: string[]
  /** Graph rows removed by adopted tombstones and redactions. */
  removed: number
  /** Findings become a redaction SUGGESTION, surfaced in status. Never a block. */
  suggestions: SecretFinding[]
}

/**
 * Adopt journal records from other machines. The gate FLAGS; it never blocks.
 *
 * The failure this handles: machine A's scanner misses a credential — older
 * version, or a shape it did not know — and B adopts the record, so B's
 * stricter scanner never saw it. Blocking here would break convergence while
 * protecting nothing, because the content is already durable at A.
 *
 * Records keep their origin machine and seq (the journal's peer files), so
 * adopting twice is a no-op. Memories that are still live after every
 * tombstone and redaction become graph rows; a tombstone or redaction removes
 * the rows it now leaves without a live record.
 */
export const adoptRecords = (records: unknown[], deps: IngestDeps): AdoptReport => {
  const now = deps.now ?? Date.now
  const { added, rejected } = deps.journal.adoptRecords(records)
  const report: AdoptReport = { added: added.length, rejected, materialized: [], removed: 0, suggestions: [] }
  if (!added.length) return report
  const live = deps.journal.replay()
  const liveIds = new Set(live.map((r) => `${r.machine}:${r.seq}`))
  const liveHashes = new Set(live.map((r) => r.contentHash))
  for (const r of added) {
    if (r.kind === 'memory' && liveIds.has(`${r.machine}:${r.seq}`)) {
      report.suggestions.push(...scanForSecrets(r.content))
      report.materialized.push(materialize(r, deps, now))
    } else if ((r.kind === 'tombstone' || r.kind === 'redaction') && !liveHashes.has(r.targetHash)) {
      report.removed += deps.store.deleteByJournalHash(r.targetHash)
    }
  }
  return report
}

/**
 * A journal record from another machine as a graph row: the reconcile ladder
 * and the graph write, without a second append.
 *
 * Its source is prefixed with its machine: the same path can exist on both
 * machines, and a local file must never find a foreign row as its own (consume
 * and stubbing go by source). Feedback is filed under user scope, so it loads
 * in every session on every node (27 Oct 2026); the scope it was written in
 * stays as provenance, an `origin_scope` edge.
 */
export const materialize = (record: MemoryRecord, deps: IngestDeps, now: () => number = deps.now ?? Date.now, opts: { own?: boolean } = {}): string => {
  const body = bodyOf(record.content)
  const bodyHash = hashContent(body)
  const { shape } = frontmatterOf(record.content)
  const scope = shape === 'feedback' ? 'user' : record.scope
  const input: IngestInput = {
    content: record.content,
    body,
    slug: record.slug ?? '',
    scope,
    // An own record (a repair: cortex-memory verify) keeps its path, so consume and stubbing still find it.
    source: opts.own ? record.source : `${record.machine}:${record.source}`,
    machine: record.machine,
    authoredAt: record.authoredAt,
    ...(record.session ? { sessionId: record.session } : {}),
  }
  const decision = reconcile(
    { slug: input.slug, scope, content: body, contentHash: bodyHash, machine: record.machine, sessionId: record.session, isRule: ruleOf(record.content) !== null },
    deps,
  )
  const id = applyDecision(decision, input, bodyHash, record.contentHash, deps, now)
  if (scope !== record.scope) {
    deps.store.upsertHub({ id: `scope:${record.scope}`, kind: 'session', name: record.scope })
    deps.store.observe(id, `scope:${record.scope}`, 'origin_scope', now())
  }
  return id
}
