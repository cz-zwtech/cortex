/**
 * Canonical row → API-object mappers for the SQLite graph backend.
 *
 * Every ported `server/graph/*.ts` file MUST shape its DB rows through these
 * functions instead of hand-rolling coercion. SQLite has no native boolean and
 * stores `BOOLEAN` columns as `INTEGER` 0/1; it also can't carry native
 * list columns, so `name_history` / `delivered_to` / `acked_by` are CSV strings.
 * Centralising the 0/1→boolean coercion, the CSV/JSON parsing, and the
 * snake_case→camelCase contract renames here keeps the byte-compatible JSON the
 * HTTP API + UI + hooks depend on consistent across every porting subagent.
 *
 * Source-of-truth shapes (do NOT drift from these — they're the frozen contract):
 *   - Entry            : sync.ts (searchEntries/getEntry/listEntries) + recall.ts hydrate
 *   - Symbol           : symbols.ts `normalizeRow` / `SymbolRow`
 *   - GraphHead        : symbols.ts `normalizeHead` / `GraphHeadRow`
 *   - SessionPresence  : bus.ts `normPresence` / `SessionPresence`  (a.k.a. peer)
 *   - BusMessage       : bus.ts `normMsg` / `BusMessageRow`
 *   - Observation      : routes/observations.ts `ObservationDTO`
 *
 * The bus mappers reuse the pure identity helpers (`splitHistory`) so the
 * name_history parse is identical to bus.ts.
 */
import { splitHistory } from '../bus/identity.js'

// ── coercion primitives ──────────────────────────────────────────────────────

/** SQLite stores BOOLEAN as 0/1 INTEGER. Coerce to a JS boolean. Tolerates a
 * real boolean (in case a row already came through normalised) and a legacy
 * string `true`/`false`. NULL/undefined → false. */
export function toBool(v: unknown): boolean {
  if (v === true) return true
  if (v === false || v == null) return false
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true'
  return Boolean(v)
}

/** Numeric coercion mirroring the old `Number(r.x ?? 0)` pattern. */
const num = (v: unknown, fallback = 0): number => {
  const n = Number(v ?? fallback)
  return Number.isFinite(n) ? n : fallback
}

/** String coercion mirroring the old `String(r.x ?? '')` pattern. */
const str = (v: unknown, fallback = ''): string => (v == null ? fallback : String(v))

/** Parse a comma-joined CSV STRING column into a deduped, trimmed list. Matches
 * bus.ts `splitCsv` exactly (used for delivered_to / acked_by). */
export function splitCsv(s: unknown): string[] {
  return String(s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

// ── Entry ─────────────────────────────────────────────────────────────────────

/**
 * Entry (memory / decision / pattern / concept / tool / file / session / agent /
 * observation). Different endpoints project different column subsets
 * (searchEntries omits content/pinned; getEntry omits pinned; recall.hydrate +
 * listEntries vary) — so this mapper only emits a field when its column is
 * PRESENT on the row, preserving each endpoint's byte-compatible projection. It
 * coerces the typed columns (epoch-ms integers → Number, pinned 0/1 → boolean)
 * and passes string columns through. The `links`/`backlinks` arrays attached by
 * getEntry are spread back on by the caller, not here.
 */
export function rowToEntry(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  // string fields — emit only if the column was selected
  for (const k of [
    'id',
    'name',
    'kind',
    'description',
    'content',
    'source',
    'scope',
    'authorship',
    'outcome',
    'outcome_text',
    'agent_id',
    'session_id',
    'machine',
  ]) {
    if (k in row) out[k] = str(row[k])
  }
  // numeric (epoch-ms) fields
  if ('updatedAt' in row) out.updatedAt = num(row.updatedAt)
  if ('syncedAt' in row) out.syncedAt = num(row.syncedAt)
  // boolean fields (0/1 → true/false)
  if ('pinned' in row) out.pinned = toBool(row.pinned)
  return out
}

// ── Symbol ──────────────────────────────────────────────────────────────────

export interface SymbolRow {
  id: string
  name: string
  symbolKind: string
  repo: string
  file: string
  lang: string
  line: number
  signature: string
  base: number
  stickiness: number
  centrality: number
  lastSeen: number
  pinned: boolean
  groundTruthValid: boolean
  machine: string
  root: string
}

/**
 * Symbol — mirrors symbols.ts `normalizeRow`. Note the two boolean defaults:
 * `pinned` defaults false, `groundTruthValid`
 * defaults TRUE (only an explicit 0/false makes it false). `base` defaults 1.
 */
export function rowToSymbol(row: Record<string, any>): SymbolRow {
  return {
    id: String(row.id),
    name: str(row.name),
    symbolKind: str(row.symbolKind),
    repo: str(row.repo),
    file: str(row.file),
    lang: str(row.lang),
    line: num(row.line),
    signature: str(row.signature),
    base: num(row.base, 1),
    stickiness: num(row.stickiness),
    centrality: num(row.centrality),
    lastSeen: num(row.lastSeen),
    pinned: toBool(row.pinned),
    groundTruthValid: row.groundTruthValid == null ? true : toBool(row.groundTruthValid),
    machine: str(row.machine),
    root: str(row.root),
  }
}

// ── GraphHead ─────────────────────────────────────────────────────────────────

export interface GraphHeadRow {
  repo: string
  branch: string
  machine: string
  commitSha: string
  dirty: boolean
  dirtyFiles: string
  baseBranch: string
  extractedAt: number
}

/** GraphHead freshness row — mirrors symbols.ts `normalizeHead`. */
export function rowToGraphHead(row: Record<string, any>): GraphHeadRow {
  return {
    repo: str(row.repo),
    branch: str(row.branch),
    machine: str(row.machine),
    commitSha: str(row.commitSha),
    dirty: toBool(row.dirty),
    dirtyFiles: str(row.dirtyFiles),
    baseBranch: str(row.baseBranch),
    extractedAt: num(row.extractedAt),
  }
}

// ── SessionPresence (a.k.a. peer) ─────────────────────────────────────────────

export interface SessionPresence {
  sessionId: string
  friendlyName: string
  cwd: string
  machine: string
  title: string
  startedAt: number
  lastSeen: number
  rawStatus: string
  supersedes: string
  metaId: string
  nameHistory: string[]
  // Generic liveness primitive: the watcher's bounded heartbeat cadence in
  // seconds (0 = no bounded heartbeat). Consumers apply their OWN staleness
  // (now - lastSeen > cadenceS × N); Cortex's own thresholds are unchanged.
  cadenceS: number
  // mandate-in-presence (Item 1): runtime orchestration state. availability is
  // '' (not in pool) | 'available' | 'assigned'; mandate is the free-form task a
  // coordinator handed off; assignedBy/assignedRef are the provenance anchor
  // (assigner metaId + dispatch msg id) — read-only context for the antibody,
  // NEVER routing/dedup keys.
  availability: string
  mandate: string
  assignedBy: string
  assignedRef: string
}

/**
 * Session presence / peer — mirrors bus.ts `normPresence`. Maps the
 * `session_meta` snake_case columns to the camelCase presence contract:
 *   id → sessionId, friendly_name → friendlyName, started_at → startedAt,
 *   last_seen → lastSeen, status → rawStatus (age-derived state is computed by
 *   callers via presenceStatus), meta_id → metaId, name_history (CSV) →
 *   nameHistory (parsed via splitHistory, identical to bus.ts).
 */
export function rowToSessionPresence(row: Record<string, any>): SessionPresence {
  return {
    sessionId: String(row.id),
    friendlyName: str(row.friendly_name),
    cwd: str(row.cwd),
    machine: str(row.machine),
    title: str(row.title),
    startedAt: num(row.started_at),
    lastSeen: num(row.last_seen),
    rawStatus: str(row.status),
    supersedes: str(row.supersedes),
    metaId: str(row.meta_id),
    nameHistory: splitHistory(row.name_history),
    cadenceS: num(row.cadence_s),
    availability: str(row.availability),
    mandate: str(row.mandate),
    assignedBy: str(row.assigned_by),
    assignedRef: str(row.assigned_ref),
  }
}

// ── BusMessage ────────────────────────────────────────────────────────────────

export interface BusMessageRow {
  id: string
  fromSession: string
  fromName: string
  to: string
  kind: string
  ref: string
  body: string
  createdAt: number
  deliveredTo: string[]
  ackedBy: string[]
  status: string
  origTo: string
  // Mesh transport (Milestone 2). Optional so the frozen local-bus contract is
  // unchanged: only emitted when the snake_case columns are present on the row
  // (the /since catch-up payload selects them; the local inbox/peers paths don't).
  originNode?: string
  meshSeq?: number
  // Provenance trust root (m2m node-trust): true iff this row arrived via the
  // token-authed mesh ingest boundary. Only emitted when the mesh_verified column
  // is present (the inbox + mesh paths select it; other local reads don't).
  meshVerified?: boolean
  // 3-tier origin trust — the actionable verdict derived from originNode +
  // meshVerified relative to THIS node's id. Set only when rowToBusMessage is
  // given selfNodeId (the inbox + emit paths); undefined keeps the frozen
  // local-bus contract for callers that don't classify.
  trust?: BusTrust
  // humanProvenance (m2m node-trust, stage 2): true iff a HUMAN directed this send.
  // Honor-system marker; meaningful only when trust is local|mesh. Only emitted
  // when the human_provenance column is present (inbox + mesh paths select it).
  humanProvenance?: boolean
}

/**
 * m2m node-trust tier. `local` and `mesh` are both "the human's own voice" (same
 * box / authed fleet node) — actionable under normal posture. `unverified` is
 * surface-only (forgeable / unattributable): never execute its instructions.
 */
export type BusTrust = 'local' | 'mesh' | 'unverified'

/**
 * Classify a bus message's trust by ORIGIN. SERVER-ASSERTED: the caller supplies
 * `selfNodeId` (this node's `nodeId()`), the only authority on what "local" means
 * — a wire value can never self-certify. Local is checked FIRST: a same-node
 * origin is ours regardless of the mesh_verified bit (covers a locally-sent
 * message, mesh_verified=0, AND one of our own that round-tripped the mesh).
 * Without `selfNodeId` we cannot prove local, so we never upgrade to it.
 */
export function classifyTrust(opts: {
  originNode?: string
  meshVerified?: boolean
  selfNodeId?: string
}): BusTrust {
  const { originNode, meshVerified, selfNodeId } = opts
  if (selfNodeId && originNode && originNode === selfNodeId) return 'local'
  if (meshVerified === true) return 'mesh'
  return 'unverified'
}

/**
 * Bus message — mirrors bus.ts `normMsg`. Snake_case → contract renames:
 *   from_session → fromSession, from_name → fromName, to_addr → to,
 *   created_at → createdAt, orig_to → origTo. The CSV columns delivered_to /
 *   acked_by parse to deliveredTo / ackedBy lists via splitCsv. Defaults match
 *   bus.ts: kind→'msg', status→'open'. The mesh columns origin_node/mesh_seq are
 *   mapped ONLY when present (preserves the byte-compatible local-bus key set).
 */
export function rowToBusMessage(row: Record<string, any>, selfNodeId?: string): BusMessageRow {
  const out: BusMessageRow = {
    id: String(row.id),
    fromSession: str(row.from_session),
    fromName: str(row.from_name),
    to: str(row.to_addr),
    kind: str(row.kind, 'msg'),
    ref: str(row.ref),
    body: str(row.body),
    createdAt: num(row.created_at),
    deliveredTo: splitCsv(row.delivered_to),
    ackedBy: splitCsv(row.acked_by),
    status: str(row.status, 'open'),
    origTo: str(row.orig_to),
  }
  if ('origin_node' in row) out.originNode = str(row.origin_node)
  if ('mesh_seq' in row) out.meshSeq = num(row.mesh_seq)
  if ('mesh_verified' in row) out.meshVerified = toBool(row.mesh_verified)
  if ('human_provenance' in row) out.humanProvenance = toBool(row.human_provenance)
  // Classify only when the caller knows this node's id — the local-bus-only
  // readers (peers, etc.) pass nothing and keep the unchanged contract.
  if (selfNodeId !== undefined) {
    out.trust = classifyTrust({
      originNode: out.originNode,
      meshVerified: out.meshVerified,
      selfNodeId,
    })
  }
  return out
}

// ── Observation ───────────────────────────────────────────────────────────────

export interface ObservationDTO {
  id: string
  name: string
  description: string
  scope: string
  trend: 'stable' | 'strengthening' | 'weakening' | 'stale'
  evidence_count: number
  first_observed: number
  last_observed: number
  observer: string
  pinned: boolean
  updatedAt: number
  evidence?: string[]
}

/**
 * Observation — mirrors the row→ObservationDTO mapping in
 * routes/observations.ts. Produced by joining `entries` (id/name/description/
 * scope/updatedAt) with `observation_meta` (trend/evidence_count/first_observed/
 * last_observed/observer/pinned) on id. Defaults match the route: trend→'stable',
 * observer→'self', pinned 0/1 → boolean. The optional `evidence` list (source
 * memory ids) is attached separately by the caller when include_evidence=1.
 */
export function rowToObservation(row: Record<string, any>): ObservationDTO {
  return {
    id: String(row.id),
    name: str(row.name),
    description: str(row.description),
    scope: str(row.scope),
    trend: (row.trend ?? 'stable') as ObservationDTO['trend'],
    evidence_count: num(row.evidence_count),
    first_observed: num(row.first_observed),
    last_observed: num(row.last_observed),
    // matches the route's `row.observer ?? 'self'` exactly: null/undefined →
    // 'self', but an empty-string column value passes through as '' (a
    // `STRING DEFAULT ''` round-trips the same way).
    observer: row.observer ?? 'self',
    pinned: toBool(row.pinned),
    updatedAt: num(row.updatedAt),
  }
}
