/**
 * ckn sync — reads Claude memory .md files and upserts them into the SQLite graph.
 *
 * Sources:
 *   ~/.claude/memory/*.md                      → scope: user
 *   ~/.claude/projects/{encoded}/memory/*.md   → scope: project:{encoded}
 */
import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { all, get, run, transaction, DB_PATH } from './db.js'
import { rowToEntry } from './_rows.js'
import { embedText, embeddingTextForEntry, getEmbeddingMode } from '../embeddings.js'
import { putEmbedding } from '../embeddingStore.js'
import { listImports } from '../importedVaults.js'
import { getMachineId } from '../privateMind.js'
import { readSyncManifest, statUnchanged, writeSyncManifest } from './syncManifest.js'
import { deriveFileMentions } from './fileMentions.js'
import {
  reconcileFileEdgeOps,
  type ReconcileOp,
  type ExistingFileEdge,
  type EdgeProvenance,
} from './reconcileFileEdges.js'
import { parseThreadState } from './threads.js'
import { syncEditedIn } from './editedIn.js'

const LAST_SYNC_PATH = path.join(path.dirname(DB_PATH), 'last-sync.json')

interface SyncMeta { timestamp: number; previous: number | null }

export async function writeLastSync(): Promise<void> {
  const previous = await readLastSync().then((m) => m?.timestamp ?? null)
  const meta: SyncMeta = { timestamp: Date.now(), previous }
  await fs.writeFile(LAST_SYNC_PATH, JSON.stringify(meta), 'utf-8')
}

export async function readLastSync(): Promise<SyncMeta | null> {
  try {
    const raw = await fs.readFile(LAST_SYNC_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<SyncMeta>
    if (!parsed.timestamp) return null
    return { timestamp: parsed.timestamp, previous: parsed.previous ?? null }
  } catch {
    return null
  }
}

// ---- helpers ---------------------------------------------------------------

const FENCE = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Root for the memory tree. `CKN_HOME` overrides `os.homedir()` so the sync,
 * mesh-apply, and 2-node gate paths can be isolated to a temp home by one env var. */
export const memoryHome = (): string => process.env.CKN_HOME || os.homedir()

export function parseFrontmatter(text: string): { data: Record<string, any>; body: string } {
  const m = text.match(FENCE)
  if (!m) return { data: {}, body: text }
  const body = text.slice(m[0].length).replace(/^\n+/, '')
  try {
    return { data: YAML.parse(m[1] ?? '') ?? {}, body }
  } catch {
    // Malformed YAML (e.g. an unquoted `description:` value that begins with
    // `@` and contains a colon parses as a nested mapping). Don't drop the
    // memory — degrade to a lenient scalar scrape of the top-level
    // `key: value` lines so the entry still syncs and stays searchable.
    const data: Record<string, any> = {}
    for (const line of (m[1] ?? '').split('\n')) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
      if (kv && kv[2] !== '') {
        data[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '').trim()
      }
    }
    return { data, body }
  }
}

// Entry id from file path: {scope}/{filename-without-ext}.
// Frontmatter `id:` wins when present — lets auto-generated artifacts
// (patterns, concepts) pin a stable id independent of where the file lives.
function entryId(encodedProject: string, filename: string): string {
  const base = path.basename(filename, path.extname(filename))
  return `${encodedProject}/${base}`
}

/**
 * Graph KINDS that can legitimately surface in a normalized file's
 * `metadata.node_type` / `metadata.type` and are NOT memory subtypes. The
 * external normalizer collapses an authored top-level `type:` into the nested
 * `metadata` block AND forces `metadata.node_type: memory` (ground truth: the
 * thread-cortex-memory-build.md repro). So a thread's only surviving kind signal
 * is `metadata.type: thread`. For a memory the same slot holds a SUBTYPE
 * (project/user/feedback/reference) which must still map to kind='memory', so we
 * promote ONLY the kinds enumerated here. Currently just `thread` (the s2 resume
 * surface). If the normalizer is later taught to preserve `node_type: thread`,
 * the node_type-first check picks it up with no change here.
 */
const KINDS_IN_METADATA = new Set<string>(['thread'])

/**
 * Memory SUBTYPES (Fable: `type` is an OVERLOADED category key, not the graph
 * kind). A file whose only kind signal is one of these is a `memory` node — the
 * subtype is descriptive, not a distinct graph kind.
 */
const MEMORY_SUBTYPES = new Set<string>(['user', 'feedback', 'project', 'reference'])

/**
 * Derive a graph node's KIND from its (possibly normalized) frontmatter.
 *
 * The kind survives in different SLOTS across shapes: top-level `type`/`kind`/
 * `node_type` (authored) and `metadata.node_type`/`metadata.type` (the external
 * normalizer nests everything and FORCES `metadata.node_type: memory`, ground
 * truth: thread-cortex-memory-build.md). Rules, in order:
 *   1. An enumerated graph KIND (KINDS_IN_METADATA, e.g. `thread`) in ANY slot
 *      wins — node_type checked before type, the canonical namespace.
 *   2. Else the first present `type`/`kind`/`metadata.node_type` that is NOT a
 *      memory subtype is the kind (covers session/pattern/etc. authored via
 *      top-level `type`).
 *   3. Else `memory` (a subtype, or no signal).
 */
export function deriveNodeKind(data: Record<string, any>): string {
  const meta =
    data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, any>)
      : {}
  const known = [data.kind, data.node_type, meta.node_type, data.type, meta.type].find(
    (s): s is string => typeof s === 'string' && KINDS_IN_METADATA.has(s),
  )
  if (known) return known
  const t = data.type ?? data.kind ?? meta.node_type
  if (typeof t === 'string' && t && !MEMORY_SUBTYPES.has(t)) return t
  return 'memory'
}

/**
 * Serialize a `thread` node's structured state from its frontmatter into the
 * JSON shape `parseThreadState` (server/graph/threads.ts) reads back. Mirrors
 * that parser field-for-field so a thread round-trips file → graph → resume.
 * YAML coerces booleans, so `pushed` is accepted as a real boolean or the
 * strings 'true'/'false'; everything else is normalized defensively.
 */
function threadContentJson(data: Record<string, any>): string {
  const pushed =
    typeof data.pushed === 'boolean'
      ? data.pushed
      : data.pushed === 'true'
        ? true
        : data.pushed === 'false'
          ? false
          : undefined
  return JSON.stringify({
    status: data.status ? String(data.status) : 'open',
    next_step: data.next_step ? String(data.next_step) : '',
    links: Array.isArray(data.links) ? data.links.map((l: any) => String(l)) : [],
    repo: data.repo ? String(data.repo) : undefined,
    branch: data.branch ? String(data.branch) : undefined,
    pushed,
  })
}

// ---- thread-strip resilience -----------------------------------------------

// Count of thread files HEALED from the graph after an external frontmatter strip
// (r3 observability — strips are a symptom of an external writer; the counter +
// the per-heal server log are how we catch one in the act later, without a
// per-writer whack-a-mole now). Reset per process; read via `threadHealCount()`.
let _threadHealCount = 0
export function threadHealCount(): number {
  return _threadHealCount
}

/**
 * Rewrite a STRIPPED thread file's frontmatter back from its graph entry — the
 * thread-strip HEAL. A thread `.md` is an exchange surface ANY external writer (a
 * peer LLM tidying frontmatter to the harness memory shape — name/description/
 * metadata.type/body — is the prime suspect) can flatten; NO Cortex serializer
 * produces the corrupted bytes, so the defense lives at the sync chokepoint, not
 * in a serializer. The graph entry holds the authoritative thread state the
 * degraded file lost, so we restore the canonical frontmatter (node_type+type
 * thread, id, status/next_step/links/repo/branch/pushed) and KEEP the file's
 * current human-prose body (the entry stores state JSON, not the body — a healed
 * file is correct frontmatter + possibly-stale narrative that self-corrects on the
 * next real snapshot). HEAL — not preserve-only — because the file is the
 * private-mind CARRIER: a poisoned file would mind-sync DEAD to a fresh laptop
 * graph that has no prior entry to preserve from. Idempotent: the healed file
 * re-derives as a healthy thread, so the next sync is a normal no-strip upsert.
 */
async function healStrippedThreadFile(
  file: string,
  entry: { id: string; name: string; description: string; content: string | null; machine: string },
  currentRaw: string,
): Promise<void> {
  const st = parseThreadState(entry.content)
  const body = parseFrontmatter(currentRaw).body
  const meta: Record<string, unknown> = {
    node_type: 'thread',
    id: entry.id,
    type: 'thread',
    status: st.status,
    next_step: st.nextStep,
    links: st.links,
  }
  if (st.repo) meta.repo = st.repo
  if (st.branch) meta.branch = st.branch
  if (typeof st.pushed === 'boolean') meta.pushed = st.pushed
  if (entry.machine) meta.machine = entry.machine
  const front = { name: entry.name, description: entry.description, metadata: meta }
  const yaml = YAML.stringify(front).trimEnd()
  await fs.writeFile(file, `---\n${yaml}\n---\n\n${body}\n`, 'utf-8')
}

/**
 * Genuine removal of dead non-thread "strip-dup" entries at a thread's source.
 * Cleans each dup's EDGES (src OR dst) BEFORE deleting the rows, in one
 * transaction — the broken-pointer convention every entity-removal path follows
 * (routes/shared.ts, derive, patterns, scope sweeps). This is genuine node
 * removal, so the OR-dst form is required (NOT the upsert src-only rule, which is
 * for a re-upsert that KEEPS the node) — else the dup's stale-derived edges
 * dangle and silently poison traversals (a recall walk hitting a dangling dst
 * gets a null join — the hollow-data class). Returns the count removed.
 */
function sweepDeadDupsAtSource(source: string): number {
  const dups = all<{ id: string }>(
    `SELECT id FROM entries WHERE source = ? AND kind != 'thread'`,
    source,
  )
  if (dups.length === 0) return 0
  transaction(() => {
    for (const d of dups) run(`DELETE FROM edges WHERE src = ? OR dst = ?`, d.id, d.id)
    run(`DELETE FROM entries WHERE source = ? AND kind != 'thread'`, source)
  })
  return dups.length
}

// ---- core upsert -----------------------------------------------------------

export interface EntryInput {
  id: string
  name: string
  kind: string
  description: string
  content: string
  source: string
  scope: string
  updatedAt: number
  /** Authorship lineage — see docs/reference/graph-schema.md. Default 'auto-extracted'. */
  authorship?: string
  /** Outcome of the action/decision/workflow this memory represents. */
  outcome?: string
  /** Verbatim outcome text — never LLM-paraphrased. */
  outcomeText?: string
  /** Set when an autonomous agent authored the memory. */
  agentId?: string
  /** Originating Claude Code session id. */
  sessionId?: string
  /** Pinned mental model — frontmatter `pinned: true`. Boosts recall. */
  pinned?: boolean
  /** Promote this feedback memory to the hard managed CLAUDE.md block —
   * frontmatter `engagement: true`. Mirrors `pinned:` (top-level flat key). */
  engagement?: boolean
  /** Machine that authored / first-synced this memory (lineage). */
  machine?: string
  /** sha256 of the raw file bytes — the change signal for re-upsert (NOT mtime). */
  contentHash?: string
}

/**
 * Upsert a single Entry: delete the node's OUTBOUND edges and the row, then
 * re-insert. Wrapped in a transaction so a reader never sees the node
 * mid-rebuild (and so the two-statement delete is atomic). `conn` is unused —
 * kept for signature compatibility with callers that still pass the SQLite
 * handle through.
 *
 * Edge ownership (decision A — consensus cortex-dev + 6d56cecc + Fable,
 * 2026-06-10): an edge belongs to the entry that DECLARES it (its src). A
 * re-upsert of X re-derives X's declarations, so it deletes only `src=X` and
 * lets inbound `U→X` stand (U owns that edge; X has no authority to drop it).
 * This is both more correct AND what unblocks the commit-2 stat-delta pre-pass:
 * because inbound edges survive a re-upsert, an UNCHANGED source U never needs
 * re-reading to "restore" U→X — so we can skip reading it entirely. The genuine
 * delete/rename paths (deleteScope, vault re-import, derive/patterns) still use
 * `src=id OR dst=id`: there the node is going away, so its inbound edges SHOULD
 * be cleaned up.
 */
/**
 * Edges the SYSTEM observes at runtime, NOT declared by an entry's file — e.g.
 * SURFACED_IN (s1 surfacing counts). Decision A says a re-upsert owns the edges the
 * entry DECLARES; an observed edge has no file source to re-derive it, so the src=id
 * wipe must EXCLUDE this class or the observed history resets on every edit (and
 * /cortex-snapshot rewrites memory files constantly). Named so the next runtime rel
 * joins it declaratively rather than by another ad-hoc exception.
 *
 * EDITED_IN (s3, file→session) is observational for the same reason: it's derived
 * from transcript edit events at sync, has no file-frontmatter source to re-derive
 * it, and its src is a file node — so a re-upsert of that node must not wipe the
 * observed edit history. (Genuine node removal still drops it via the src=id OR
 * dst=id sweep — that's a node going away, not a re-derive.)
 */
export const OBSERVATIONAL_RELS = ['SURFACED_IN', 'EDITED_IN'] as const

export function upsertEntry(_conn: unknown, entry: EntryInput): void {
  const syncedAt = Date.now()
  transaction(() => {
    // Wipe only the entry's DECLARED outbound edges; observational rels are owned by
    // the system (not the file), so they survive the re-upsert (decision A).
    run(
      `DELETE FROM edges WHERE src = ? AND rel NOT IN (${OBSERVATIONAL_RELS.map(() => '?').join(',')})`,
      entry.id,
      ...OBSERVATIONAL_RELS,
    )
    run('DELETE FROM entries WHERE id = ?', entry.id)
    run(
      `INSERT INTO entries
         (id, name, kind, description, content, source, scope, updatedAt, syncedAt,
          authorship, outcome, outcome_text, agent_id, session_id, pinned, engagement, machine,
          content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.name,
      entry.kind,
      entry.description,
      entry.content,
      entry.source,
      entry.scope,
      entry.updatedAt,
      syncedAt,
      entry.authorship ?? 'auto-extracted',
      entry.outcome ?? '',
      entry.outcomeText ?? '',
      entry.agentId ?? '',
      entry.sessionId ?? '',
      entry.pinned === true ? 1 : 0,
      entry.engagement === true ? 1 : 0,
      entry.machine ?? '',
      entry.contentHash ?? '',
    )
  })
}

/**
 * Idempotently create a LINKS_TO edge. The composite PK (src,dst,rel) makes
 * this a free INSERT OR IGNORE — no pre-existence SELECT needed.
 */
function ensureEdge(_conn: unknown, fromId: string, toId: string, label: string): void {
  run(
    `INSERT OR IGNORE INTO edges (src, dst, rel, label) VALUES (?, ?, 'LINKS_TO', ?)`,
    fromId,
    toId,
    label,
  )
}

// ---- file scanning ---------------------------------------------------------

async function scanDir(dir: string): Promise<string[]> {
  const files: string[] = []
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md') {
      files.push(full)
    }
  }
  return files
}

// ---- main sync -------------------------------------------------------------

export interface SyncResult {
  synced: number
  skipped: number
  errors: string[]
  /** Thread files healed from the graph after an external frontmatter strip. */
  healed?: number
}

interface PendingEdges {
  from: string
  mentionsFiles: string[]
  mentionsTools: string[]
  resolves: string[]
  contradicts: string[]
  occurredIn: string | null
  evolvedFrom: string | null
  agentId: string
}

// Single-flight coalescing for /api/graph/sync (commit-1 c). N sessions hitting
// their Stop-hook sync near-simultaneously used to queue N full passes behind the
// write lock — the multiplicative saturation. Callers arriving while a pass is in
// flight share it; everyone arriving DURING it shares ONE trailing pass (their
// writes may have landed after the active pass began reading). A burst of N thus
// collapses to 2 runs, not N. Module-level state — there is one graph per process.
let syncActive: Promise<unknown> | null = null
let syncTrailing: Promise<unknown> | null = null

export function coalesceSync<T>(run: () => Promise<T>): Promise<T> {
  if (!syncActive) {
    const p = (async () => {
      try {
        return await run()
      } finally {
        if (syncActive === p) syncActive = null
      }
    })()
    syncActive = p
    return p
  }
  // A pass is active — coalesce all arrivals into a single trailing pass.
  if (!syncTrailing) {
    const prev = syncActive
    const t = (async () => {
      try {
        await prev
      } catch {
        // the active pass's failure belongs to its own callers, not the trailing run
      }
      try {
        return await run()
      } finally {
        if (syncTrailing === t) syncTrailing = null
      }
    })()
    syncTrailing = t
  }
  return syncTrailing as Promise<T>
}

export async function syncMemories(home: string): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: [], healed: 0 }
  const pendingEdges: PendingEdges[] = []

  // Snapshot the existing content_hash per entry so we can skip files whose
  // content is byte-identical to what's already in the graph. The upsert path
  // is destructive (delete + insert) and re-embeds, both of which dominate sync
  // cost — skipping them when the content is unchanged keeps an all-skip sync
  // fast (~1s for ~1300 files: read+hash dominated, not parse+embed). This is
  // load-bearing for the Stop-hook HTTP path staying inside its 60s timeout
  // when multiple sessions stop near-simultaneously.
  //
  // CONTENT HASH (not mtime) is the change signal: a body-only edit whose mtime
  // does NOT advance (atomic-rename editors that preserve mtime, coarse-
  // granularity filesystems, sub-second re-edits) was silently skipped under the
  // old mtime delta-skip -> the graph kept the stale body. Hashing the raw bytes
  // detects the change regardless of what the mtime did.
  const existingHashById = new Map<string, string>()
  // Also key by source path. `id` can come from frontmatter (so it needs a file
  // read to know), but source==file path is knowable up front, so the per-file
  // change test below can use either key.
  const existingHashBySource = new Map<string, string>()
  // Existing thread entries keyed by their source path — the cheap pre-filter for
  // the thread-strip resilience check below (threads are rare, so the per-file
  // strip lookup only fires for the handful of files that already back a thread,
  // not every memory). Piggybacks this single full scan; no extra query.
  const threadSourcesById = new Map<string, string>() // source path → thread id
  try {
    const rows = all<{ id: string; source: string | null; content_hash: string | null; kind: string }>(
      'SELECT id, source, content_hash, kind FROM entries',
    )
    for (const row of rows) {
      const h = row.content_hash ?? ''
      existingHashById.set(row.id, h)
      if (row.source) existingHashBySource.set(row.source, h)
      if (row.kind === 'thread' && row.source) threadSourcesById.set(row.source, row.id)
    }
  } catch {
    // Best-effort — on failure we just fall through to full re-sync.
  }

  // Collect all memory files
  const sources: Array<{ file: string; encodedProject: string; scope: string }> = []

  // User-level: ~/.claude/memory/*.md
  const userMemDir = path.join(home, '.claude', 'memory')
  for (const file of await scanDir(userMemDir)) {
    sources.push({ file, encodedProject: 'user', scope: 'user' })
  }
  // User-level concepts: ~/.claude/memory/concepts/*.md — auto-generated
  // tool/concept stubs. Frontmatter declares the synthetic scope (e.g.
  // 'tool') so the path-derived 'user' here is just a fallback.
  const userConceptsDir = path.join(home, '.claude', 'memory', 'concepts')
  for (const file of await scanDir(userConceptsDir)) {
    sources.push({ file, encodedProject: 'user', scope: 'user' })
  }

  // Project-level: ~/.claude/projects/{encoded}/memory/*.md
  const projectsDir = path.join(home, '.claude', 'projects')
  let projectEntries: Dirent[] = []
  try {
    projectEntries = await fs.readdir(projectsDir, { withFileTypes: true })
  } catch {}

  for (const proj of projectEntries) {
    if (!proj.isDirectory()) continue
    const memDir = path.join(projectsDir, proj.name, 'memory')
    for (const file of await scanDir(memDir)) {
      sources.push({
        file,
        encodedProject: proj.name,
        scope: `project:${proj.name}`,
      })
    }
  }

  // Stat-gated read-and-hash pre-pass (commit-2). Reading + sha256-ing every
  // file each run was the residual ~4s of /mnt-WSL small-file IO after commit-1.
  // The sync_manifest records each file's (mtime,size); a file whose stat is
  // unchanged AND that already has a graph entry is SKIPPED without opening it —
  // its content is what we last ingested. Stat is the read-GATE, not the source
  // of truth: for files we DO open (stat changed, or new) the content_hash
  // delta-check stays authoritative, so a body edit that changes size (and
  // almost always mtime) is still caught. The only thing skipped is a
  // same-(mtime,size) content swap — accepted as negligible.
  //
  // Decision A (re-upsert deletes only src=id) is the precondition: inbound
  // edges survive a re-upsert, so an unchanged source never needs re-reading to
  // restore its edges — making the read-skip safe. When nothing changed (the
  // common /snapshot, Stop-hook, SessionEnd case) no node is upserted, so the
  // edge passes B/C below are unnecessary.
  const manifest = readSyncManifest()
  const fileRaw = new Map<string, string>()
  const fileHash = new Map<string, string>()
  const fileMtimeMs = new Map<string, number>()
  // Files skipped on the stat fast-path — never opened, never edge-processed.
  const statSkipped = new Set<string>()
  // (mtime,size) to persist for files we statted-as-changed/new. Stat-skipped
  // files already match the manifest, so they need no rewrite — keeping the
  // all-skip manifest write empty (the whole point of the fast path).
  const manifestUpdates: Array<{ path: string; mtime: number; size: number }> = []
  let anyChanged = false
  // Ids upserted this sync — the incremental scope for the name-mention pass (b').
  const changedIds: string[] = []
  for (const { file } of sources) {
    try {
      const st = await fs.stat(file)
      const mtime = Math.floor(st.mtimeMs)
      const size = st.size
      // Skip iff (mtime,size) unchanged AND an entry already exists for this
      // source. Gating on an existing entry keeps a wiped graph correct: no
      // entry ⟹ read + re-ingest even if the manifest still carries the stat
      // (the manifest lives in the same DB, so a graph wipe drops it too — this
      // is belt-and-suspenders).
      if (statUnchanged(file, mtime, size, manifest) && existingHashBySource.has(file)) {
        statSkipped.add(file)
        continue
      }
      manifestUpdates.push({ path: file, mtime, size })
      fileMtimeMs.set(file, mtime)
      const raw = await fs.readFile(file, 'utf-8')
      const hash = createHash('sha256').update(raw).digest('hex')
      fileRaw.set(file, raw)
      fileHash.set(file, hash)
      const prev = existingHashBySource.get(file)
      if (prev === undefined || prev !== hash) anyChanged = true
    } catch {
      anyChanged = true // can't stat/read — fall back to the full read path
    }
  }

  // Process each file
  for (const { file, encodedProject, scope: pathScope } of sources) {
    try {
      // Stat fast-path: this file's (mtime,size) matched the manifest and it
      // already has an entry — never opened in the pre-pass, so nothing to
      // process. Its declared edges are intact (decision A keeps inbound; its
      // own outbound were never deleted since it wasn't re-upserted).
      if (statSkipped.has(file)) {
        result.skipped++
        continue
      }
      // Fast path: this file's content is unchanged AND nothing else changed
      // this run, so no upsert will run and its edges are safe — skip the
      // YAML-parse. (When something DID change, we still process every file so
      // the edge re-queue can re-create edges that point at a re-upserted node.)
      const hash = fileHash.get(file)
      if (!anyChanged) {
        const prev = existingHashBySource.get(file)
        if (hash !== undefined && prev !== undefined && prev === hash) {
          result.skipped++
          continue
        }
      }
      // Reuse the raw text + mtime captured during the read-and-hash pre-pass —
      // do NOT re-read. If the pre-pass couldn't read the file, fall back here.
      const raw = fileRaw.get(file) ?? (await fs.readFile(file, 'utf-8'))
      const mtimeMs = fileMtimeMs.get(file) ?? Math.floor((await fs.stat(file)).mtimeMs)
      const contentHash = hash ?? createHash('sha256').update(raw).digest('hex')
      const { data, body } = parseFrontmatter(raw)

      // The external memory-frontmatter normalizer rewrites an authored file's
      // top-level fields into a canonical `metadata: {node_type, type, ...rest}`
      // nested shape — see the ground-truth repro
      // (~/.claude/projects/-mnt-e-Repos-personal/memory/thread-cortex-memory-build.md):
      // a thread authored with top-level `type: thread` becomes
      //   metadata: { node_type: memory, type: thread, status, next_step, links, id, ... }
      // i.e. node_type is FORCED to `memory`, the original `type` is preserved,
      // and the WHOLE structured state nests under `metadata`.
      //
      // KIND derivation (consensus cortex-dev+driver+Fable): node_type is the
      // canonical/immune namespace, so it's checked FIRST — but because the
      // normalizer currently forces it to `memory`, we accept a KNOWN graph kind
      // from metadata.type as the fallback (a memory's metadata.type is a SUBTYPE
      // — project/user/feedback/reference — so only promote enumerated kinds, else
      // every memory would become a 'project'/'user' node). Legacy top-level
      // `type`/`kind` still win for the un-normalized authored shape.
      const meta =
        data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
          ? (data.metadata as Record<string, any>)
          : {}
      // Kind derivation handles the authored vs normalizer-nested shapes — see
      // deriveNodeKind. (Extracted so the rule has ONE tested home.)
      const kind = deriveNodeKind(data)

      // For a thread the normalizer nests id/scope/state under `metadata` too, so
      // read a merged view (top-level wins). Scoped to threads: applying this to
      // memories would reshuffle their id scheme (the routed dual-id question), so
      // non-threads keep top-level-only reads, unchanged.
      const ff = kind === 'thread' ? { ...meta, ...data } : data
      // Frontmatter wins for both id and scope. Lets auto-generated
      // artifacts (patterns, concepts) declare synthetic scopes like
      // 'pattern:auto' or 'tool' regardless of where the file sits.
      const id = ff.id ? String(ff.id) : entryId(encodedProject, file)
      const scope = ff.scope ? String(ff.scope) : pathScope
      const name = String(ff.name ?? path.basename(file, '.md'))
      const description = String(ff.description ?? '')
      // For a `thread` node the STRUCTURED state lives in `content` as JSON
      // (parseThreadState reads it) — NOT the markdown body. The frontmatter is
      // the source of that state (status/next_step/links/repo/branch/pushed);
      // the body stays human prose. Without this, a thread .md would sync HOLLOW
      // (parseThreadState can't JSON.parse prose → empty next_step), which is the
      // anti-hollow failure the s2 litmus catches. `ff` already merges the nested
      // metadata, so the state reads from BOTH the authored and normalized shapes.
      // Other kinds keep the body as content (truncated to 8k to keep the DB lean).
      const content = kind === 'thread' ? threadContentJson(ff) : body.slice(0, 8192)
      // mtime is still stored (useful for ordering/display) but is NO LONGER
      // the change signal — content_hash is (see delta-skip below).
      const updatedAt = mtimeMs

      // Authorship + outcome metadata. Frontmatter is authoritative when
      // present; older files without these keys default to 'auto-extracted'
      // (per the migration policy in docs/reference/graph-schema.md). LLM-extracted
      // outcome_text is verbatim — sync just passes it through.
      const authorship = data.authorship ? String(data.authorship) : 'auto-extracted'
      const outcome = data.outcome ? String(data.outcome) : ''
      const outcomeText = data.outcome_text ? String(data.outcome_text) : ''
      const agentId = data.agent_id ? String(data.agent_id) : ''
      const sessionId = data.session_id ? String(data.session_id) : ''
      // Pinned mental models — user-curated load-bearing memories.
      // Frontmatter `pinned: true` boosts recall score and overrides
      // stale-trend handling on observations.
      const pinned = data.pinned === true || data.pinned === 'true'
      // Engagement directives — a feedback memory tagged `engagement: true`
      // (top-level flat key, like `pinned:`) is promoted to the hard managed
      // CLAUDE.md block instead of the soft profile injection.
      const engagement = data.engagement === true || data.engagement === 'true'
      // Lineage — which machine authored / first-synced this memory.
      // Frontmatter `machine:` is authoritative (preserved verbatim when a
      // memory is adopted from another machine via private-mind); absent →
      // attribute to the local machine doing the sync. `ff` reads the normalizer-
      // nested `metadata.machine` for threads (top-level for other kinds).
      const machine = ff.machine ? String(ff.machine) : getMachineId()

      // Always queue edges — ensureTypedEdge is idempotent and upserts
      // elsewhere in this run can delete a target node and wipe inbound
      // edges. Re-queueing keeps cross-entry edges intact even when the
      // source memory itself is delta-skipped below.
      pendingEdges.push({
        from: id,
        mentionsFiles: Array.isArray(data.mentions_files)
          ? data.mentions_files.map((f: any) => String(f))
          : [],
        mentionsTools: Array.isArray(data.mentions_tools)
          ? data.mentions_tools.map((t: any) => String(t))
          : [],
        resolves: Array.isArray(data.resolves)
          ? data.resolves.map((r: any) => String(r))
          : [],
        contradicts: Array.isArray(data.contradicts)
          ? data.contradicts.map((c: any) => String(c))
          : [],
        occurredIn: data.occurred_in ? String(data.occurred_in) : null,
        evolvedFrom: data.evolved_from ? String(data.evolved_from) : null,
        agentId,
      })

      // Delta-skip by CONTENT HASH: if the file's bytes are byte-identical to
      // what we last ingested, leave the existing node + embedding intact —
      // regardless of mtime. This is the fix: a body-only edit that preserves
      // mtime (atomic-rename editors, coarse FS granularity, sub-second
      // re-edits) now correctly re-upserts because its hash differs; and a
      // no-op touch (mtime bumped, content identical) correctly does NOT
      // re-upsert because its hash matches. The edge queue above still
      // re-checks cross-references.
      const prevHash = existingHashById.get(id)
      if (prevHash !== undefined && prevHash === contentHash && prevHash !== '') {
        result.skipped++
        continue
      }

      // ── Thread-strip RESILIENCE (see healStrippedThreadFile) ──────────────
      // Keyed off `source` (the file path — the one identity a strip CANNOT
      // remove), so ONE trigger covers both strip shapes: id-INTACT (would
      // overwrite the good entry) and id-DROPPED (would spawn a path-derived dead
      // dup that shadows the thread). NARROW (consensus cortex-dev+PM+Fable): fires
      // only when a prior thread that HAS state would lose its kind (Branch 1) or
      // be hollowed to status=open + empty next_step (Branch 2). A full-frontmatter
      // snapshot update never matches; to retire a thread use status:done or delete
      // the file, and to PARK one without a next_step set status pending/blocked
      // (an OPEN thread always carries a next_step — the s2a anti-hollow invariant,
      // so anything in Branch 2 is a strip or a write-discipline violation; preserve
      // wins both). On a hit: PRESERVE the graph thread (skip the downgrade upsert)
      // + HEAL the file from the entry + clean any dead dup. Mirrors s1
      // OBSERVATIONAL_RELS: the graph holds authority the degraded file can't override.
      const priorThread = threadSourcesById.has(file)
        ? get<{ id: string; name: string; description: string; content: string | null; machine: string }>(
            `SELECT id, name, description, content, machine FROM entries WHERE source = ? AND kind = 'thread'`,
            file,
          )
        : null
      if (priorThread) {
        const prior = parseThreadState(priorThread.content)
        const priorHasState = prior.status !== 'open' || prior.nextStep !== ''
        const incoming = kind === 'thread' ? parseThreadState(content) : null
        const incomingHollow = !incoming || (incoming.status === 'open' && incoming.nextStep === '')
        if (priorHasState && (kind !== 'thread' || incomingHollow)) {
          await healStrippedThreadFile(file, priorThread, raw)
          // r5: clean any dead non-thread entry left at this source by a pre-fix
          // strip (a thread file backs ONLY its thread entry — any non-thread row
          // at the same source is a strip dup). By SOURCE, robust to whatever id
          // the strip resolved to; edges-first genuine removal. Witnessed count.
          const dupsCleaned = sweepDeadDupsAtSource(file)
          _threadHealCount++
          result.healed = (result.healed ?? 0) + 1
          console.warn(
            `[ckn sync] thread-strip HEALED: ${priorThread.id} <- ${file} ` +
              `(incoming kind=${kind}, hollow=${incomingHollow}, dead-dups cleaned=${dupsCleaned}) ` +
              `— restored from graph + file rewritten`,
          )
          continue // do NOT upsert the stripped downgrade; the graph thread stands
        }
        // r5 widening (Fable): not a strip → a HEALTHY thread re-sync. Sweep any
        // dead non-thread dup a PRIOR strip left at this source — the structural
        // close of the dup class (no orphan-sweep pass, no admin endpoint; same
        // single-writer home). Gated on kind==='thread' so only a genuine healthy
        // thread sweeps; the file's own thread entry (kind='thread') is excluded
        // and re-upserted below. Any dup a future heal leaves is cleaned on the
        // next healthy sync.
        if (kind === 'thread') {
          const swept = sweepDeadDupsAtSource(file)
          if (swept) console.warn(`[ckn sync] thread-source dead-dup swept: ${swept} at ${file}`)
        }
      }

      upsertEntry(null, {
        id, name, kind, description, content, source: file, scope, updatedAt,
        authorship, outcome, outcomeText, agentId, sessionId, pinned, engagement, machine,
        contentHash,
      })

      // Embed on upsert. Skipped silently when CKN_EMBEDDINGS=off or
      // when the local model failed to load. Embedding errors never
      // break the sync — the entry is already in the graph; semantic
      // search just doesn't find it until a future sync re-attempts.
      if (getEmbeddingMode() !== 'off') {
        try {
          const text = embeddingTextForEntry({ name, description, content })
          const vec = await embedText(text)
          if (vec) await putEmbedding(id, vec)
        } catch {
          // best-effort
        }
      }

      changedIds.push(id) // upserted this sync — incremental scope for the name-mention pass
      result.synced++

      // M4 live propagation: broadcast a mem frame on fresh/changed memories so
      // peers adopt this version within the gossip interval. Mesh-gated so
      // non-mesh boxes are unaffected; failures never break local sync.
      try {
        const { meshEnabled } = await import('../bus/meshAuth.js')
        if (meshEnabled()) {
          const { localToRepoMemoryPath, recordLocalMemory } = await import('./memMesh.js')
          const repoPath = localToRepoMemoryPath(file)
          if (repoPath) recordLocalMemory({ id, repoPath, scope, content: raw, machine })
        }
      } catch { /* mesh off / not built — local sync unaffected */ }
    } catch (e: any) {
      result.errors.push(`${file}: ${e.message}`)
      result.skipped++
    }
  }

  // Second pass A: materialize typed edges declared in frontmatter.
  // Auto-create stubs for referenced files/tools/sessions/agents when
  // they don't yet exist — per docs/reference/graph-schema.md, these are first-class
  // nodes in the graph and must exist for the typed edge to land.
  // Empty graph before this sync = a rebuild (every node effectively new) → full
  // passes. Otherwise scope both edge passes to the entries changed this sync
  // (commit-1 b′/b″). Computed once; reused by the name-mention pass below.
  const wasEmptyGraph = existingHashById.size === 0
  try {
    materializeTypedEdges(null, scopePendingEdges(pendingEdges, wasEmptyGraph ? null : changedIds))
  } catch (e: any) {
    result.errors.push(`typed-edge pass: ${e.message}`)
  }

  // §5.3 incremental memory→file derivation — see deriveFileEdgesForChanged.
  // Scoped to the entries upserted this sync (changedIds): bounded, never a
  // full-graph rescan. On an empty-graph rebuild changedIds already holds every
  // memory, so no null/full distinction is needed. Runs AFTER the frontmatter
  // typed-edge pass so the frontmatter edges it preserves already exist; empty
  // changedIds (all-skip sync) is an early no-op.
  try {
    deriveFileEdgesForChanged(changedIds)
  } catch (e: any) {
    result.errors.push(`file-derivation pass: ${e.message}`)
  }

  // Passes B and C only matter when something actually changed on disk.
  // On an all-skip sync (nothing upserted) the name-mention edges and the
  // vault replay are already current from the prior sync — re-running them
  // every time is what kept an all-skip sync at ~7s. The graph wipe rebuild
  // case is preserved: an empty graph makes every file look new, so
  // `anyChanged` is true and both passes run.
  if (anyChanged) {
    // Second pass B: connect entries to other entries whose name appears
    // in their body. Catches the case where memory files don't yet have
    // mentions_* frontmatter (older or hand-written entries) but still
    // talk about the same concept by name. Uses LINKS_TO (legacy) — kept
    // until typed extraction (Phase 1) populates MENTIONS_* directly.
    try {
      // Incremental: scan only entries changed this sync (changed × all-targets
      // + all × changed-targets) instead of the O(N²) full scan that cost 14.6s
      // at ~6.3k entries (sync-saturation-fix-proposal.md). Full scan (null) runs
      // only for the empty-graph rebuild computed above.
      inferNameMentionEdges(null, wasEmptyGraph ? null : changedIds)
    } catch (e: any) {
      result.errors.push(`name-mention pass: ${e.message}`)
    }

    // Replay recorded vault imports so the graph stays rebuildable from
    // disk + config. Without this, deleting the graph loses every vault-
    // imported entry until the user manually re-runs the import dialog.
    // Best-effort: failures don't break the sync — they just mean those
    // vault entries are missing from the graph this run.
    try {
      const vaults = await listImports()
      if (vaults.length > 0) {
        const { importVaultPaths } = await import('./vaultImport.js')
        for (const v of vaults) {
          try {
            await importVaultPaths(v.vaultName, v.paths)
          } catch (e: any) {
            result.errors.push(`vault ${v.vaultName}: ${e?.message ?? e}`)
          }
        }
      }
    } catch {
      // imported-vaults.json missing or unreadable — fine, no replay
    }
  }

  // s3: derive EDITED_IN edges from CHANGED session transcripts (Option C, r2
  // incremental — shares the sync_manifest). Runs UNCONDITIONALLY (not gated on
  // `anyChanged`): a session edits files without touching any memory .md, so a
  // transcript can change while every memory is stat-skipped. Its own stat-gate
  // keeps an all-unchanged sync cheap. Best-effort — a transcript parse failure
  // never breaks the memory sync.
  try {
    await syncEditedIn(home, manifest, manifestUpdates)
  } catch (e: any) {
    result.errors.push(`edited-in pass: ${e.message}`)
  }

  // Persist the (mtime,size) of every file we statted-as-changed/new so the
  // next sync's stat fast-path can skip them. Stat-skipped files already match
  // the manifest, so this is empty on an all-skip sync.
  writeSyncManifest(manifestUpdates)

  await writeLastSync()
  return result
}

// ── typed-edge materialization ─────────────────────────────────────────────

export const fileEntryId = (filePath: string): string =>
  `file:${filePath.replace(/\//g, '_').replace(/\\/g, '_')}`

const toolEntryId = (toolName: string): string =>
  `tool:${toolName.toLowerCase()}`

/**
 * Ensure an Entry exists for `id`. Creates a stub with the given kind
 * and scope when missing. Idempotent — safe to call repeatedly.
 */
export function ensureStubEntry(
  _conn: unknown,
  id: string,
  name: string,
  kind: string,
  scope: string,
): void {
  const exists = get<{ id: string }>('SELECT id FROM entries WHERE id = ? LIMIT 1', id)
  if (exists) return
  const now = Date.now()
  run(
    `INSERT INTO entries
       (id, name, kind, description, content, source, scope, updatedAt, syncedAt,
        authorship, outcome, outcome_text, agent_id, session_id, pinned, engagement, machine,
        content_hash)
     VALUES (?, ?, ?, '', '', '', ?, ?, ?, 'auto-extracted', '', '', '', '', 0, 0, '', '')`,
    id,
    name,
    kind,
    scope,
    now,
    now,
  )
}

/**
 * Idempotently create a typed edge between two entries. The composite PK
 * (src,dst,rel) makes this a free INSERT OR IGNORE. `extra` carries the
 * optional notedAt timestamp for CONTRADICTS / EVOLVED_INTO (the only typed
 * edges that set a property). Other props default in DDL.
 */
function ensureTypedEdge(
  _conn: unknown,
  rel: string,
  fromId: string,
  toId: string,
  notedAt?: number,
): void {
  if (notedAt !== undefined) {
    run(
      `INSERT OR IGNORE INTO edges (src, dst, rel, notedAt) VALUES (?, ?, ?, ?)`,
      fromId,
      toId,
      rel,
      notedAt,
    )
  } else {
    run(
      `INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, ?)`,
      fromId,
      toId,
      rel,
    )
  }
}

/**
 * Scope the pending typed-edge set to what this sync must (re)materialize
 * (commit-1 b″). `upsertEntry` deletes a re-upserted entry's OUTBOUND edges
 * (src=id), so those must be re-created from its pending edge — keep a pending
 * edge iff its source changed.
 *
 * The reverse-edge clause (keep a pending edge that points AT a changed id) is
 * now a SAFETY NET, not load-bearing: under decision A the re-upsert no longer
 * deletes inbound edges (dst=id), so U→X survives X's re-upsert without
 * restoration. Re-materializing it is a harmless INSERT OR IGNORE no-op, and it
 * still legitimately catches the case where X is BRAND NEW (the U→X edge never
 * existed and U declared it). `changedIds == null` = empty-graph rebuild →
 * materialize everything.
 */
export function scopePendingEdges(
  pending: PendingEdges[],
  changedIds: string[] | null,
): PendingEdges[] {
  if (changedIds == null) return pending
  const changed = new Set(changedIds)
  return pending.filter(
    (p) =>
      changed.has(p.from) ||
      (p.evolvedFrom != null && changed.has(p.evolvedFrom)) ||
      (p.occurredIn != null && changed.has(p.occurredIn)) ||
      p.contradicts.some((c) => changed.has(c)) ||
      p.resolves.some((r) => changed.has(r)),
  )
}

function materializeTypedEdges(_conn: unknown, pending: PendingEdges[]): void {
  const now = Date.now()
  // One transaction for the whole pass — many small INSERT OR IGNOREs;
  // wrapping them keeps the writer-window brief and is 10-100× faster than
  // per-statement autocommit.
  transaction(() => {
    for (const p of pending) {
      // Files — auto-create stubs and add MENTIONS_FILE edges
      for (const f of p.mentionsFiles) {
        const fid = fileEntryId(f)
        ensureStubEntry(null, fid, f, 'file', 'file')
        ensureTypedEdge(null, 'MENTIONS_FILE', p.from, fid)
      }
      // Tools — auto-create stubs and add MENTIONS_TOOL edges
      for (const t of p.mentionsTools) {
        const tid = toolEntryId(t)
        ensureStubEntry(null, tid, t, 'tool', 'tool')
        ensureTypedEdge(null, 'MENTIONS_TOOL', p.from, tid)
      }
      // Resolves — explicit error references
      for (const errId of p.resolves) {
        // Don't auto-create — if the error doesn't exist yet, the edge waits
        ensureTypedEdge(null, 'RESOLVES', p.from, errId)
      }
      // Contradicts
      for (const otherId of p.contradicts) {
        ensureTypedEdge(null, 'CONTRADICTS', p.from, otherId, now)
      }
      // Occurred in session
      if (p.occurredIn) {
        ensureStubEntry(null, p.occurredIn, p.occurredIn, 'session', `session:${p.occurredIn}`)
        ensureTypedEdge(null, 'OCCURRED_IN', p.from, p.occurredIn)
      }
      // Evolved from
      if (p.evolvedFrom) {
        ensureTypedEdge(null, 'EVOLVED_INTO', p.evolvedFrom, p.from, now)
      }
      // Authored by agent
      if (p.agentId) {
        const aid = `agent:${p.agentId}`
        ensureStubEntry(null, aid, p.agentId, 'agent', 'agent')
        ensureTypedEdge(null, 'AUTHORED_BY', p.from, aid)
      }
    }
  })
}

// ── memory→file edge reconcile (shared by the 0009 backfill + §5.3 sync pass) ──

/**
 * Apply the reconcile ops for ONE memory's MENTIONS_FILE edges. The single tested
 * home for the create/upgrade/downgrade/remove writes — `backfillLinkage`
 * (corpus-wide) and `deriveFileEdgesForChanged` (sync, per changed file) both call
 * it after computing ops via `reconcileFileEdgeOps`. `pathById` maps a file stub id
 * back to its verbatim path for stub creation; falls back to decoding the id.
 * Returns counts (created = new edges; updated = upgrade/downgrade/remove).
 */
export function applyFileEdgeOps(
  memoryId: string,
  ops: ReconcileOp[],
  pathById: Map<string, string>,
): { created: number; updated: number } {
  let created = 0
  let updated = 0
  for (const op of ops) {
    const prov: EdgeProvenance | null =
      op.action === 'create-frontmatter' || op.action === 'upgrade'
        ? 'frontmatter'
        : op.action === 'create-derived' || op.action === 'downgrade'
          ? 'derived'
          : null
    if (op.action === 'create-frontmatter' || op.action === 'create-derived') {
      // `pathById` covers every create op from both callers (backfill + sync build
      // it from the same derive/frontmatter sets), so the decode is an unreached
      // defensive fallback — and it is lossy for filenames containing '_'.
      const verbatim = pathById.get(op.dst) ?? op.dst.replace(/^file:/, '').replace(/_/g, '/')
      ensureStubEntry(null, op.dst, verbatim, 'file', 'file')
      // `reconcileFileEdgeOps` only emits create-* when no edge exists yet
      // (prov===undefined), so this INSERT OR IGNORE is effectively an INSERT —
      // `created` doesn't overcount a pre-existing edge.
      run(
        `INSERT OR IGNORE INTO edges (src, dst, rel, provenance) VALUES (?, ?, 'MENTIONS_FILE', ?)`,
        memoryId,
        op.dst,
        prov,
      )
      created++
    } else if (op.action === 'remove') {
      run(`DELETE FROM edges WHERE src = ? AND dst = ? AND rel = 'MENTIONS_FILE'`, memoryId, op.dst)
      updated++
    } else {
      run(
        `UPDATE edges SET provenance = ? WHERE src = ? AND dst = ? AND rel = 'MENTIONS_FILE'`,
        prov,
        memoryId,
        op.dst,
      )
      updated++
    }
  }
  return { created, updated }
}

/**
 * §5.3 incremental memory→file derivation. For the entries CHANGED this sync ONLY
 * (bounded — never a full-graph rescan, the commit-1 constraint), derive file
 * mentions from body+description and reconcile MENTIONS_FILE edges per file, so a
 * memory that mentions a path in prose WITHOUT listing it in `mentions_files` still
 * auto-links (as provenance=derived) going forward. Frontmatter intent always wins.
 *
 * Run AFTER the frontmatter typed-edge pass (`materializeTypedEdges`) so the
 * frontmatter edges it must preserve already exist; the per-file read treats those
 * as the memory's frontmatter (legacy NULL ⇒ frontmatter). Mirrors
 * `backfillLinkage`'s per-memory core, scoped to changedIds, with NO triage pass —
 * the per-file upsert already deletes a re-synced memory's stale outbound edges, so
 * staleness is handled without a corpus-wide sweep.
 */
export function deriveFileEdgesForChanged(
  changedIds: string[],
): { scanned: number; created: number; updated: number } {
  let scanned = 0
  let created = 0
  let updated = 0
  if (changedIds.length === 0) return { scanned, created, updated }
  transaction(() => {
    for (const id of changedIds) {
      const m = get<{ id: string; content: string | null; description: string | null }>(
        `SELECT id, content, description FROM entries WHERE id = ? AND kind NOT IN ('session','file','tool')`,
        id,
      )
      if (!m) continue
      scanned++
      const text = `${m.content ?? ''}\n${m.description ?? ''}`
      // verbatim path → stub id, kept for stub creation (§1: name is verbatim).
      const pathById = new Map<string, string>()
      for (const p of deriveFileMentions(text)) pathById.set(fileEntryId(p), p)
      const derivedDsts = [...pathById.keys()]

      const existing: ExistingFileEdge[] = all<{ dst: string; provenance: string | null }>(
        `SELECT dst, provenance FROM edges WHERE src = ? AND rel = 'MENTIONS_FILE'`,
        id,
      ).map((e) => ({ dst: e.dst, provenance: (e.provenance as EdgeProvenance) || 'frontmatter' }))
      // Post-`materializeTypedEdges`, the existing MENTIONS_FILE edges ARE this
      // memory's current frontmatter (the upsert wiped+recreated them). Treat them
      // as the frontmatter set so a file in both frontmatter and body keeps ONE
      // frontmatter edge, never a derived duplicate.
      const frontmatterDsts = existing.filter((e) => e.provenance === 'frontmatter').map((e) => e.dst)

      const r = applyFileEdgeOps(id, reconcileFileEdgeOps(existing, frontmatterDsts, derivedDsts), pathById)
      created += r.created
      updated += r.updated
    }
  })
  return { scanned, created, updated }
}

// Connect entries by name mentions in body content. Bidirectional concepts
// (e.g. "logging" mentioned in entry A connects A → entry B titled "logging").
// Threshold: name length >= 5 chars to avoid noise from common words.
//
// INCREMENTAL (commit-1 sync-saturation fix): a full O(N²) scan — every source
// body × every target name-regex — was 14.6s of a 28s sync at ~6.3k entries,
// rebuilding the same edges each run. When the caller passes `changedIds` (the
// entries upserted this sync), only (re)evaluate the pairs that could differ:
//   - a CHANGED source × ALL targets   (its body may now mention anything)
//   - every source × the CHANGED targets (their names are new/renamed)
// The union is exactly what a full scan would touch for those nodes, at
// O(changed × N) instead of O(N²). `changedIds == null` (omitted) means a full
// scan — the empty-graph rebuild path, where every node is effectively new.
export function inferNameMentionEdges(_conn: unknown, changedIds?: string[] | null): void {
  const rows = all<{ id: string; name: string; content: string }>(
    'SELECT id, name, content FROM entries',
  )

  // Pre-build a list of (entry, escaped-name regex) for entries with names long
  // enough to match meaningfully. Skip very short names which would produce
  // false positives (e.g. "log", "id").
  const targets = rows
    .filter((r) => r.name && r.name.length >= 5)
    .map((r) => ({
      id: r.id,
      name: r.name,
      pattern: new RegExp(`\\b${escapeRegex(r.name)}\\b`, 'i'),
    }))

  const changed = changedIds == null ? null : new Set(changedIds)
  // Targets whose own node changed — the "all-sources × changed-target" arm.
  const changedTargets = changed ? targets.filter((t) => changed.has(t.id)) : targets

  // Collect the new edges first (pure read), then write them all in one
  // transaction. Same correctness as the per-edge ensureEdge loop, far fewer
  // autocommit fsyncs.
  const toCreate: Array<{ src: string; dst: string }> = []
  for (const src of rows) {
    if (!src.content) continue
    // A changed source is matched against ALL targets; an unchanged source only
    // against the changed targets (so a renamed/new name still links inbound).
    // Full scan (changed == null) treats every source as changed.
    const srcChanged = changed ? changed.has(src.id) : true
    const scan = srcChanged ? targets : changedTargets
    for (const tgt of scan) {
      if (tgt.id === src.id) continue
      if (tgt.pattern.test(src.content)) {
        toCreate.push({ src: src.id, dst: tgt.id })
      }
    }
  }
  if (toCreate.length === 0) return
  transaction(() => {
    for (const e of toCreate) ensureEdge(null, e.src, e.dst, 'mentions')
  })
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---- query helpers (used by routes) ----------------------------------------

export async function queryStats() {
  const nodeRow = get<{ count: number | bigint }>('SELECT count(*) AS count FROM entries')
  const edgeRow = get<{ count: number | bigint }>(
    `SELECT count(*) AS count FROM edges WHERE rel = 'LINKS_TO'`,
  )
  const meta = await readLastSync()

  return {
    nodes: Number(nodeRow?.count ?? 0),
    edges: Number(edgeRow?.count ?? 0),
    lastSync: meta?.timestamp ?? null,
    previousSync: meta?.previous ?? null,
  }
}

export async function searchEntries(query: string, limit = 20) {
  // Byte-faithful `lower(x) CONTAINS q` substring scan (blueprint
  // §1.8 v1). LIKE with escaped wildcards reproduces CONTAINS exactly; do NOT
  // switch to FTS5 yet (token vs substring semantics differ). lower() on both
  // sides makes the match case-insensitive.
  const q = query.toLowerCase()
  const like = `%${likeEscape(q)}%`
  const rows = all<Record<string, any>>(
    `SELECT id, name, kind, description, scope, source, updatedAt
       FROM entries
      WHERE lower(name) LIKE ? ESCAPE '\\'
         OR lower(description) LIKE ? ESCAPE '\\'
         OR lower(content) LIKE ? ESCAPE '\\'
      LIMIT ?`,
    like,
    like,
    like,
    limit,
  )
  return rows.map(rowToEntry)
}

// Escape LIKE metacharacters so a query containing %, _ or \ matches them
// literally (CONTAINS is a pure substring test — no wildcards).
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export async function getEntry(id: string) {
  const row = get<Record<string, any>>(
    `SELECT id, name, kind, description, content, scope, source, updatedAt
       FROM entries WHERE id = ?`,
    id,
  )
  if (!row) return null

  // Outbound links
  const links = all<Record<string, any>>(
    `SELECT t.id AS id, t.name AS name, t.kind AS kind, e.label AS label
       FROM edges e
       JOIN entries t ON t.id = e.dst
      WHERE e.rel = 'LINKS_TO' AND e.src = ?`,
    id,
  )

  // Inbound links (backlinks)
  const backlinks = all<Record<string, any>>(
    `SELECT s.id AS id, s.name AS name, s.kind AS kind, e.label AS label
       FROM edges e
       JOIN entries s ON s.id = e.src
      WHERE e.rel = 'LINKS_TO' AND e.dst = ?`,
    id,
  )

  return { ...rowToEntry(row), links, backlinks }
}

export async function getAllForGraph() {
  // Node projection ADDS updatedAt + syncedAt vs the original projection (blueprint
  // §3.6): the UX GraphView temporal layout arranges nodes by `syncedAt ??
  // updatedAt`. Purely additive — every prior field is preserved.
  const nodes = all<Record<string, any>>(
    'SELECT id, name, kind, scope, updatedAt, syncedAt FROM entries',
  ).map((r) => {
    const e = rowToEntry(r)
    // The original returned bare projected rows; rowToEntry yields the same
    // keys (id/name/kind/scope strings + updatedAt/syncedAt numbers).
    return e
  })

  // Edge shape: { from, to, label } per LINKS_TO edge.
  const edges = all<{ from: string; to: string; label: string }>(
    `SELECT src AS "from", dst AS "to", label FROM edges WHERE rel = 'LINKS_TO'`,
  )

  return { nodes, edges }
}

// List all distinct scopes in the graph with entry counts. Used by the vault
// import dialog to show what's already in the graph and let the user purge.
export async function listScopes() {
  return all<{ scope: string; count: number }>(
    'SELECT scope AS scope, count(*) AS count FROM entries GROUP BY scope ORDER BY count DESC',
  )
}

// All distinct kinds in the graph with entry counts. Used by the Knowledge
// view's kind facet so the list reflects the whole graph, not just the
// currently-loaded results page.
export async function listKinds() {
  return all<{ kind: string; count: number }>(
    'SELECT kind AS kind, count(*) AS count FROM entries GROUP BY kind ORDER BY count DESC',
  )
}

/**
 * One-time cleanup: remove the empty wikilink concept stubs that prior
 * versions of `syncMemories` and `importVaultPaths` created. Stubs share
 * `scope = 'vault'` and `content = ''`; rich entries from real memory
 * imports use `scope = 'vault:<name>'` so this filter is safe.
 *
 * `inferNameMentionEdges` produces equivalent connectivity from rich
 * content, so dropping these doesn't lose real graph topology.
 */
export async function pruneStubs(): Promise<number> {
  const before = get<{ c: number }>(
    `SELECT count(*) AS c FROM entries WHERE scope = 'vault' AND content = ''`,
  )
  const count = Number(before?.c ?? 0)
  if (count === 0) return 0
  transaction(() => {
    // DETACH DELETE: drop incident edges then the rows. Edge endpoints for
    // these stubs are matched by the same scope/content predicate via a
    // subquery so we never leave a dangling edge.
    run(
      `DELETE FROM edges WHERE src IN (SELECT id FROM entries WHERE scope = 'vault' AND content = '')
                            OR dst IN (SELECT id FROM entries WHERE scope = 'vault' AND content = '')`,
    )
    run(`DELETE FROM entries WHERE scope = 'vault' AND content = ''`)
  })
  return count
}

/**
 * Remove orphan stub Entry nodes: rows with content = '' that participate in
 * NO relationship. These accumulate when a memory referencing a file/tool/
 * session/agent/concept is re-upserted (delete + insert) without the
 * reference — the auto-created stub target is left dangling.
 *
 * Single-statement port (blueprint §3.7): the unified `edges` table makes the
 * "is this id connected?" test a single NOT IN over the union of both endpoint
 * columns. ABOUT (Entry→Symbol) lives in the same table, so its src side is
 * naturally included — no separate per-rel-table collection dance needed.
 *
 * Only content='' rows are eligible, so real memories (which always have body
 * content) are never touched even if momentarily edgeless. Complements
 * pruneStubs (scope='vault'), which targets a narrower legacy population.
 */
export async function pruneOrphanStubs(): Promise<number> {
  // Count first so we can return the number removed (RunResult.changes would
  // also work, but the explicit count keeps the contract obvious + matches the
  // "compute orphan set, then delete" shape).
  const before = get<{ c: number }>(
    `SELECT count(*) AS c
       FROM entries
      WHERE content = ''
        AND id NOT IN (SELECT src FROM edges UNION SELECT dst FROM edges)`,
  )
  const count = Number(before?.c ?? 0)
  if (count === 0) return 0
  run(
    `DELETE FROM entries
      WHERE content = ''
        AND id NOT IN (SELECT src FROM edges UNION SELECT dst FROM edges)`,
  )
  return count
}

// Delete every node (and its edges, via the explicit edge delete) under a scope.
export async function deleteScope(scope: string): Promise<number> {
  const before = get<{ c: number }>(
    'SELECT count(*) AS c FROM entries WHERE scope = ?',
    scope,
  )
  const beforeCount = Number(before?.c ?? 0)
  if (beforeCount === 0) return 0
  transaction(() => {
    run(
      `DELETE FROM edges WHERE src IN (SELECT id FROM entries WHERE scope = ?)
                            OR dst IN (SELECT id FROM entries WHERE scope = ?)`,
      scope,
      scope,
    )
    run('DELETE FROM entries WHERE scope = ?', scope)
  })
  return beforeCount
}

export async function entriesByMachine(): Promise<Record<string, number>> {
  const rows = all<{ machine: string | null; count: number | bigint }>(
    'SELECT machine AS machine, count(*) AS count FROM entries GROUP BY machine',
  )
  const out: Record<string, number> = {}
  for (const row of rows) out[String(row.machine ?? '')] = Number(row.count ?? 0)
  return out
}

export async function listEntries(
  kind?: string,
  since?: number,
  limit = 100,
  sort: 'updated' | 'synced' = 'updated',
  syncedSince?: number,
  scope?: string,
  machine?: string,
) {
  const clauses: string[] = []
  const params: any[] = []
  if (kind) {
    clauses.push('kind = ?')
    params.push(kind)
  }
  if (scope) {
    clauses.push('scope = ?')
    params.push(scope)
  }
  if (since) {
    clauses.push('updatedAt >= ?')
    params.push(since)
  }
  if (syncedSince) {
    clauses.push('syncedAt >= ?')
    params.push(syncedSince)
  }
  if (machine) {
    clauses.push('machine = ?')
    params.push(machine)
  }
  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  // orderField is a fixed identifier (never user input) — safe to inline.
  const orderField = sort === 'synced' ? 'syncedAt' : 'updatedAt'
  const rows = all<Record<string, any>>(
    `SELECT id, name, kind, description, scope, updatedAt, syncedAt
       FROM entries ${whereClause}
      ORDER BY ${orderField} DESC LIMIT ?`,
    ...params,
    limit,
  )
  return rows.map(rowToEntry)
}
