import { nanoid } from 'nanoid'
import { all, get, run, transaction } from './db.js'
import {
  rowToSessionPresence,
  rowToBusMessage,
  splitCsv,
  type SessionPresence,
  type BusMessageRow,
} from './_rows.js'
import { nodeId } from '../bus/meshIdentity.js'
import { localTranscriptIds } from '../../bin/_session-id.js'
import { emitBusMessage, emitBusState } from '../bus/busEvents.js'
import {
  resolveFriendlyName,
  shouldRebind,
  mintMetaId,
  aliasSetFor,
  selfIdSet,
  deliveredToSelf,
  priorIncarnations,
  LIVE_MS,
  splitHistory,
  joinHistory,
  foldNameHistory,
} from '../bus/identity.js'
import { AVAILABILITY, deriveMandate } from '../bus/mandate.js'

/**
 * Bus schema is now part of the canonical SQLite DDL (schema.sql: session_meta +
 * bus_messages, both with the bus columns + orig_to). initSchema applies it on
 * every boot, so this is a no-op kept only for call-site compatibility — the
 * routes/CLI still `await ensureBusSchema(...)` and the FederatedBroker calls it.
 */
export async function ensureBusSchema(_conn?: unknown): Promise<void> {
  // schema.sql owns session_meta + bus_messages; nothing to ALTER at runtime.
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterInput {
  sessionId: string
  title?: string
  autoName?: string
  cwd: string
  machine: string
  // Optionally pre-resolved durable identity. The LOCAL (Graph) tier ignores
  // these and computes its own via claimMetaId (it's authoritative); the
  // FederatedBroker fills them from the local result so the REMOTE (Redis)
  // presence mirror carries the same alias set for cross-machine reads.
  metaId?: string
  nameHistory?: string[]
}

export type { SessionPresence, BusMessageRow }

export interface SendInput {
  fromSession: string
  fromName: string
  to: string // friendly name | session id | metaId | '*'
  kind: 'msg' | 'ack' | 'reply' | 'done' | 'probe'
  ref?: string
  body: string
  // Optional pre-assigned id. The local (Graph) broker always mints its own;
  // FederatedBroker passes the local id to the Redis copy so a same-machine peer
  // reading both tiers' inboxes dedupes them by id (no double-delivered broadcast).
  id?: string
  // For kind='probe' (marco-polo escalation): the ORIGINAL targeted address that
  // went unanswered. A reader auto-acks a probe iff origTo ∈ its alias set.
  origTo?: string
  // humanProvenance (m2m node-trust, stage 2): set true when a HUMAN directed this
  // send (e.g. `ckn-bus send --human`). Honor-system, stored verbatim; meaningful
  // only on a trusted source. Default false (agent/unknown).
  humanProvenance?: boolean
}

// ---------------------------------------------------------------------------
// CSV helpers (no native list columns — comma-joined STRING). splitCsv is the
// canonical _rows.ts mapper; joinCsv (dedupe + comma-join) is bus-local.
// ---------------------------------------------------------------------------

const joinCsv = (xs: string[]): string => Array.from(new Set(xs)).join(',')

// ---------------------------------------------------------------------------
// Row projections — the column lists the row mappers consume. session_meta and
// bus_messages select '*' so rowToSessionPresence / rowToBusMessage see every
// snake_case column they expect.
// ---------------------------------------------------------------------------

const PRESENCE_SELECT = `SELECT * FROM session_meta`
// Shared column list (NOT `*`) so the mesh columns origin_node/mesh_seq never leak
// into the frozen local BusMessageRow shape that inbox/listPeers callers (watcher,
// UI, hooks) depend on. The mesh catch-up path uses MSG_SELECT_MESH below, which
// DOES carry them.
const MSG_COLS =
  `id, from_session, from_name, to_addr, kind, ref, body, created_at, ` +
  `delivered_to, acked_by, status, orig_to`
// Inbox delivery path: MSG_COLS PLUS the provenance fields (origin_node +
// mesh_verified) so a receiving session can tell a genuinely mesh-authenticated
// peer message from a locally-claimed one (m2m node-trust). Deliberately NOT
// mesh_seq — that stays internal to the replication path.
const MSG_SELECT_INBOX = `SELECT ${MSG_COLS}, origin_node, mesh_verified, human_provenance FROM bus_messages`
// Mesh catch-up / replication path: includes origin_node + mesh_seq so the
// /since payload reconciles full sender state on the receiver.
const MSG_SELECT_MESH = `SELECT * FROM bus_messages`

// ---------------------------------------------------------------------------
// registerSession — read-then-write with rebind
// ---------------------------------------------------------------------------

export async function registerSession(input: RegisterInput): Promise<SessionPresence> {
  const friendlyName = resolveFriendlyName({
    title: input.title,
    autoName: input.autoName,
    sessionId: input.sessionId,
  })
  await ensureBusSchema()
  const now = Date.now()

  return transaction(() => {
    // Rebind/supersede scan operates on the PRE-floor resolved `friendlyName` (the bare-id
    // fallback in the floored no-title case), and runs BEFORE priorRow + the name-floor
    // below are computed. Intentional + unchanged from HEAD: the floored/preserved name is
    // NOT collision-scanned here. Scanning on the effective (preserved) name would interact
    // with shouldRebind's both-transcripts / peer-race semantics, so it is deliberately
    // deferred out of this name-floor fix — tracked as a follow-up FR.
    let supersedes = ''
    if (friendlyName && input.cwd) {
      const priors = all<{ id: string }>(
        `SELECT id FROM session_meta WHERE friendly_name = ? AND cwd = ? AND id <> ? AND status = 'live'`,
        friendlyName,
        input.cwd,
        input.sessionId,
      )
      // Transcript existence breaks name ties: a transcript-backed row wins, so a
      // bootstrap PHANTOM (no transcript) can't sign off the real session. Scan
      // only on an actual collision (priors present) to keep registration cheap.
      const tx = priors.length ? localTranscriptIds() : new Set<string>()
      for (const p of priors) {
        if (
          shouldRebind(
            { friendlyName, cwd: input.cwd, sessionId: input.sessionId, hasTranscript: tx.has(input.sessionId) },
            { friendlyName, cwd: input.cwd, sessionId: p.id, status: 'live', hasTranscript: tx.has(p.id) },
          )
        ) {
          run(`UPDATE session_meta SET status = 'signed_off' WHERE id = ?`, p.id)
          supersedes = p.id
        }
      }
    }

    const priorRow = get<{ meta_id?: string; friendly_name?: string; title?: string; name_history?: string }>(
      `SELECT meta_id, friendly_name, title, name_history FROM session_meta WHERE id = ?`,
      input.sessionId,
    )
    const exists = priorRow !== undefined

    // Name-FLOOR (#47 "name survives /compact"). A post-compact SessionStart re-register
    // arrives with an EMPTY title and no autoName — ckn-context.ts only POSTs
    // {sessionId, title, cwd, machine} with title = topic ?? '', so a missed transcript
    // read yields a nameless payload; resolveFriendlyName then falls back to the bare id
    // and the exists-branch UPDATE below would CLOBBER a /rename'd friendly_name AND blank
    // its title. Floor it: when the register carries NO name signal and the prior row
    // already holds a NON-bare name, preserve BOTH fields — closing the register/touch
    // asymmetry (touchSession is non-clobbering for the same reason). An explicit
    // title/autoName always wins (rename + bare→named upgrade unaffected); a born-bare
    // session has no prior and hits the INSERT branch untouched. ASSUMPTION: no legitimate
    // caller un-names a session via an empty-title register — clearing a name needs an
    // explicit signal, never an implicit blank.
    const namelessInput = !(input.title ?? '').trim() && !(input.autoName ?? '').trim()
    const priorFriendly = String(priorRow?.friendly_name ?? '').trim()
    const priorIsBare = priorFriendly === input.sessionId.slice(0, 8)
    const floorName = exists && namelessInput && !!priorFriendly && !priorIsBare
    const effectiveName = floorName ? priorFriendly : friendlyName
    const effectiveTitle = floorName ? String(priorRow?.title ?? '') : (input.title ?? '')

    // Claim a durable metaId (order: keep existing → reclaim by title → reclaim
    // by cwd → mint). Resume keeps the same sessionId, so an existing row keeps
    // its metaId for free; a NEW session renamed to a known title (or in a known
    // cwd) reclaims that identity + its undelivered messages.
    const metaId = claimMetaId({
      sessionId: input.sessionId,
      existingMetaId: priorRow?.meta_id,
      title: effectiveTitle.trim(),
      friendlyName: effectiveName,
      cwd: input.cwd,
      now,
    })

    // Fold a rename's prior name into history so messages to the OLD name still
    // resolve (the alias set includes name_history). On first create there's no
    // prior name to retain.
    const priorName = String(priorRow?.friendly_name ?? '')
    const nameHistory = joinHistory(
      foldNameHistory(splitHistory(priorRow?.name_history ?? ''), priorName, effectiveName),
    )

    if (exists) {
      run(
        `UPDATE session_meta SET last_seen = ?, status = 'live', friendly_name = ?, ` +
          `cwd = ?, machine = ?, title = ?, meta_id = ?, name_history = ?` +
          (supersedes ? `, supersedes = ?` : '') +
          ` WHERE id = ?`,
        ...(supersedes
          ? [now, effectiveName, input.cwd, input.machine, effectiveTitle, metaId, nameHistory, supersedes, input.sessionId]
          : [now, effectiveName, input.cwd, input.machine, effectiveTitle, metaId, nameHistory, input.sessionId]),
      )
    } else {
      run(
        `INSERT INTO session_meta (id, started_at, ended_at, turns_count, files_touched_count, ` +
          `tools_used_count, final_state, auto_named, friendly_name, cwd, machine, title, ` +
          `last_seen, status, supersedes, meta_id, name_history) ` +
          `VALUES (?, ?, 0, 0, 0, 0, '', 0, ?, ?, ?, ?, ?, 'live', ?, ?, ?)`,
        input.sessionId,
        now,
        effectiveName,
        input.cwd,
        input.machine,
        effectiveTitle,
        now,
        supersedes,
        metaId,
        nameHistory,
      )
    }
    const row = get<Record<string, any>>(`${PRESENCE_SELECT} WHERE id = ?`, input.sessionId)
    return rowToSessionPresence(row ?? {})
  })
}

/**
 * Resolve the durable metaId for a registering session. Runs INSIDE the bus
 * write transaction (called from registerSession / touchSession). Order:
 *   1. session already has a metaId → keep it (resume / re-register).
 *   2. its title matches another session's title → reclaim that metaId (a new
 *      session /renamed to a known title inherits the identity).
 *   3. its cwd matches a prior session's cwd → reclaim (cwd-as-persona fallback).
 *   4. mint a fresh one.
 * Reclaim prefers a UNIQUE donor (collision → mint). Never reclaims from itself.
 */
function claimMetaId(s: {
  sessionId: string
  existingMetaId?: string
  title: string
  friendlyName: string
  cwd: string
  now: number
}): string {
  const existing = (s.existingMetaId ?? '').trim()
  if (existing) return existing

  // Reclaim a prior identity's metaId — but ONLY when it's UNAMBIGUOUS *and* the
  // donor is NOT a concurrently-live session. A title/name is the persona key,
  // yet a user can run two distinct LIVE sessions with the same title; merging
  // them onto one metaId is the session-isolation bug — one session answers for
  // the other and single-session sends fan out. A reclaimable donor has ENDED
  // (signed_off) or gone QUIET (last_seen older than LIVE_MS) = a genuine resume.
  // Liveness is COMPUTED from last_seen, never the stored status column (which
  // goes stale — a row 8 days dead was found stored 'live'). Gather the DISTINCT
  // metaIds matching the predicate; reclaim only when exactly one exists.
  const liveFloor = s.now - LIVE_MS
  const notLive = `(status = 'signed_off' OR last_seen < ?)`
  const distinctMetaIds = (where: string, params: any[]): string[] => {
    const rows = all<{ meta_id: string }>(
      `SELECT DISTINCT meta_id FROM session_meta WHERE ${where} AND ${notLive} AND id <> ? AND meta_id <> ''`,
      ...params,
      liveFloor,
      s.sessionId,
    )
    return rows.map((r) => r.meta_id).filter(Boolean)
  }
  const reclaimUnique = (where: string, params: any[]): string | null => {
    const ids = distinctMetaIds(where, params)
    return ids.length === 1 ? ids[0]! : null // 0 → none here; >1 → collision, never merge
  }

  // (1) reclaim by title — the persona key — from a not-live donor only.
  if (s.title) {
    const byTitle = reclaimUnique(`title = ?`, [s.title])
    if (byTitle) return byTitle
  }
  // (2) reclaim by friendly name (current or retired) from a not-live donor only.
  if (s.friendlyName) {
    const byName = reclaimUnique(`(friendly_name = ? OR name_history LIKE ?)`, [
      s.friendlyName,
      `%${s.friendlyName}%`,
    ])
    if (byName) return byName
  }
  // cwd is NOT an identity key — removed. A shared repo is not a resume signal:
  // even restricted to signed_off donors, cwd-reclaim merged two distinct
  // SEQUENTIAL sessions that shared one home directory onto a single metaId.
  // Resume continuity stays via the stable sessionId (the existing-
  // metaId fast path) and the title/name keys above; cwd alone never establishes
  // identity.

  // (3) mint a fresh durable id.
  return mintMetaId()
}

/**
 * Backfill: split a collided metaId so each sharer owns its own identity. Mints
 * a FRESH metaId for every session_meta row sharing `metaId` (mint-for-all);
 * pass `keep` to leave the metaId on one nominated session and split the rest
 * (keep-one). The claimMetaId fix prevents NEW collisions — this repairs LEGACY
 * ones (e.g. the 4-way meta_2lAMd55srF3s). Routes through the single writer as an
 * UPDATE, never a DELETE. Messages still addressed to the old metaId orphan
 * (senders re-address by name/sessionId), so take an online .backup first and
 * give peers a heads-up. Blank/unknown metaId is a safe no-op.
 */
export function splitMetaId(
  metaId: string,
  keep?: string,
): { metaId: string; reassigned: { id: string; newMetaId: string }[] } {
  const reassigned: { id: string; newMetaId: string }[] = []
  if (!metaId.trim()) return { metaId, reassigned }
  transaction(() => {
    const rows = all<{ id: string }>(`SELECT id FROM session_meta WHERE meta_id = ?`, metaId)
    for (const { id } of rows) {
      if (keep && id === keep) continue
      const fresh = mintMetaId()
      run(`UPDATE session_meta SET meta_id = ? WHERE id = ?`, fresh, id)
      reassigned.push({ id, newMetaId: fresh })
    }
  })
  if (reassigned.length) console.log(`[bus] split metaId '${metaId}' → ${reassigned.length} fresh identit${reassigned.length === 1 ? 'y' : 'ies'}${keep ? ` (kept on ${keep})` : ''}`)
  return { metaId, reassigned }
}

// ---------------------------------------------------------------------------
// heartbeat + signoff
// ---------------------------------------------------------------------------

export async function heartbeat(sessionId: string): Promise<void> {
  if (!sessionId) return
  await ensureBusSchema()
  run(
    `UPDATE session_meta SET last_seen = ?, status = 'live' WHERE id = ? AND status <> 'signed_off'`,
    Date.now(),
    sessionId,
  )
}

/**
 * touchSession — self-healing heartbeat. Upserts a presence as `live` and bumps
 * `last_seen` on every genuine user prompt (UserPromptSubmit). Unlike
 * `heartbeat`, it REVIVES a `signed_off` row — a real prompt is definitive proof
 * the session is alive again (covers `-c`/`--resume` of a signed-off session and
 * a SessionStart registration that silently failed because the server was down).
 * Unlike `registerSession`, it never overwrites `friendly_name`/`title`/
 * `started_at`/`supersedes`, so a `/rename`d identity survives. Creates with the
 * short-id name only when the session was never registered at all.
 *
 * Identity: a session whose SessionStart `register` was missed (server down at
 * launch) FIRST appears here, via the heartbeat. So touch must also claim a
 * durable metaId — otherwise a touch-first session stays metaId-less forever and
 * is unaddressable by identity (peers messaging its metaId black-hole). It runs
 * the same `claimMetaId` resolution as register (reclaim-by-name/cwd → mint;
 * title is usually unset on this path, so name/cwd carry it), and BACKFILLS an
 * existing row whose `meta_id` is blank (heals sessions created before this fix).
 */
export async function touchSession(
  sessionId: string,
  cwd?: string,
  machine?: string,
  cadenceS?: number,
): Promise<void> {
  if (!sessionId) return
  await ensureBusSchema()
  const now = Date.now()
  // Only record a cadence when a finite value is passed. The per-prompt
  // pause-context touch sends NO cadence — it must not clobber an existing
  // cadence_s to 0 (that would erase a watcher's recorded heartbeat interval).
  const hasCadence = typeof cadenceS === 'number' && Number.isFinite(cadenceS)

  transaction(() => {
    const prior = get<{
      id?: string
      meta_id?: string
      friendly_name?: string
      title?: string
      cwd?: string
    }>(
      `SELECT id, meta_id, friendly_name, title, cwd FROM session_meta WHERE id = ?`,
      sessionId,
    )

    if (prior) {
      const sets: string[] = [`last_seen = ?`, `status = 'live'`]
      const params: any[] = [now]
      if (cwd) {
        sets.push(`cwd = ?`)
        params.push(cwd)
      }
      if (machine) {
        sets.push(`machine = ?`)
        params.push(machine)
      }
      if (hasCadence) {
        sets.push(`cadence_s = ?`)
        params.push(cadenceS)
      }
      // Backfill identity if missing — a blank meta_id means this row was created
      // by a prior touch (or pre-metaId build). Reclaim/mint so it becomes
      // addressable. Never overwrite an existing meta_id.
      if (!String(prior.meta_id ?? '').trim()) {
        const metaId = claimMetaId({
          sessionId,
          existingMetaId: '',
          title: String(prior.title ?? '').trim(),
          friendlyName: String(prior.friendly_name ?? '').trim(),
          cwd: cwd ?? String(prior.cwd ?? ''),
          now,
        })
        sets.push(`meta_id = ?`)
        params.push(metaId)
      }
      params.push(sessionId)
      run(`UPDATE session_meta SET ${sets.join(', ')} WHERE id = ?`, ...params)
    } else {
      const friendlyName = sessionId.slice(0, 8)
      // Touch-first session: claim a durable identity on creation (no title on
      // this path, so reclaim keys off name/cwd, else mints).
      const metaId = claimMetaId({
        sessionId,
        existingMetaId: '',
        title: '',
        friendlyName,
        cwd: cwd ?? '',
        now,
      })
      run(
        `INSERT INTO session_meta (id, started_at, ended_at, turns_count, files_touched_count, ` +
          `tools_used_count, final_state, auto_named, friendly_name, cwd, machine, title, ` +
          `last_seen, status, supersedes, meta_id, name_history, cadence_s) ` +
          `VALUES (?, ?, 0, 0, 0, 0, '', 0, ?, ?, ?, '', ?, 'live', '', ?, '', ?)`,
        sessionId,
        now,
        friendlyName,
        cwd ?? '',
        machine ?? '',
        now,
        metaId,
        hasCadence ? cadenceS : 0,
      )
    }
  })
}

export async function signoff(sessionId: string): Promise<void> {
  if (!sessionId) return
  await ensureBusSchema()
  run(
    `UPDATE session_meta SET status = 'signed_off', last_seen = ? WHERE id = ?`,
    Date.now(),
    sessionId,
  )
}

// ---------------------------------------------------------------------------
// sendMessage, inbox, markDelivered, ackMessage, listPeers
// ---------------------------------------------------------------------------

export async function sendMessage(input: SendInput): Promise<{ id: string }> {
  const id = input.id ?? `m_${nanoid(10)}`
  await ensureBusSchema()
  const createdAt = Date.now()
  const origin = nodeId()
  // Stamp this node's id + a monotonic per-node seq: a locally-originated
  // message is what peers durable-catch-up via /since (origin_node + mesh_seq).
  // The counter bump + INSERT share one transaction so the stamped seq is
  // unique and atomic with the row write.
  transaction(() => {
    const next = bumpMeshSeq(origin)
    run(
      // mesh_verified is HARD-CODED 0 here: a locally-originated / API-submitted
      // message can NEVER be provenance-verified (only ingestMeshMessage, behind the
      // token-authed boundary, may set it 1). This is the load-bearing invariant — a
      // forged `from` cannot self-certify. human_provenance, by contrast, is the
      // SENDER's honor-system marker (0/1) — stored verbatim; it is only trusted
      // when combined with a trusted source on the receiver.
      `INSERT INTO bus_messages (id, from_session, from_name, to_addr, kind, ref, body, ` +
        `created_at, delivered_to, acked_by, status, orig_to, origin_node, mesh_seq, mesh_verified, human_provenance) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', 'open', ?, ?, ?, 0, ?)`,
      id,
      input.fromSession,
      input.fromName,
      input.to,
      input.kind,
      input.ref ?? '',
      input.body,
      createdAt,
      input.origTo ?? '',
      origin,
      next,
      input.humanProvenance ? 1 : 0,
    )
  })
  // Surface to the local SSE channel so a watching session sees it instantly
  // (vs. on its next poll tick). Read back the stamped row for a faithful shape.
  const row = get<Record<string, any>>(`${MSG_SELECT_MESH} WHERE id = ?`, id)
  if (row) emitBusMessage(rowToBusMessage(row, nodeId()))
  return { id }
}

/** True iff any bus message references <refId> — i.e. a reply/ack to it has landed. The
 *  ground truth for a `waiting-on:bus=<msgid>` resume predicate (#89). */
export function hasReplyTo(refId: string): boolean {
  if (!refId) return false
  return !!get<{ x: number }>(`SELECT 1 AS x FROM bus_messages WHERE ref = ? LIMIT 1`, refId)
}

export async function inbox(
  sessionId: string,
  opts: { undeliveredOnly?: boolean } = {},
): Promise<BusMessageRow[]> {
  await ensureBusSchema()
  const sRow = get<{
    fname?: string
    started_at?: number
    meta_id?: string
    name_history?: string
  }>(
    `SELECT friendly_name AS fname, started_at, meta_id, name_history FROM session_meta WHERE id = ?`,
    sessionId,
  )
  // Sibling incarnations: every session row sharing this metaId — the durable
  // identity across /compact + resume drift (decision #5 / stage 3B). Their ids +
  // prefixes join the alias set (so a peer addressing ANY past id resolves to the
  // live session), and delivery dedups across them (no re-flood after a resume).
  const metaId = (sRow?.meta_id ?? '').trim()
  const allSiblings = metaId
    ? all<{ id: string; started_at?: number; status?: string; last_seen?: number }>(
        `SELECT id, started_at, status, last_seen FROM session_meta WHERE meta_id = ? AND id <> ?`,
        metaId,
        sessionId,
      )
    : []
  // Only TRUE prior incarnations (signed_off / gone-quiet) are "me across resume".
  // A concurrent LIVE session sharing this metaId (legacy cwd-reclaim over-merge)
  // is a DIFFERENT voice — never answer for it or dedup with it (cross-bleed guard).
  const siblings = priorIncarnations(
    allSiblings.map((s) => ({
      id: s.id,
      started_at: s.started_at,
      rawStatus: s.status ?? '',
      lastSeen: Number(s.last_seen ?? 0),
    })),
    Date.now(),
  )
  const siblingIds = siblings.map((s) => s.id)
  // The reader's full alias set — sessionId(+prefix), metaId, current name, every
  // retired name, every sibling id(+prefix), and '*'. A message to ANY resolves.
  const aliases = aliasSetFor({
    sessionId,
    metaId,
    friendlyName: sRow?.fname,
    nameHistory: splitHistory(sRow?.name_history ?? ''),
    siblingIds,
  })
  const selfIds = selfIdSet(sessionId, siblingIds)
  const aliasList = Array.from(aliases)
  const selfList = Array.from(selfIds)
  const aliasPh = aliasList.map(() => '?').join(',')
  const selfPh = selfList.map(() => '?').join(',')
  // Exclude my OWN sends across all incarnations (not just the current id).
  const dbRows = all<Record<string, any>>(
    `${MSG_SELECT_INBOX} WHERE to_addr IN (${aliasPh}) AND from_session NOT IN (${selfPh}) ORDER BY created_at ASC`,
    ...aliasList,
    ...selfList,
  )
  // Trust is RECIPIENT-relative — classify against this node's id (the reader's
  // box). nodeId() is host-stable; read once, not per row.
  const self = nodeId()
  let rows = dbRows.map((r) => rowToBusMessage(r, self))
  // Catch-up dedup: delivered to ANY incarnation = delivered (no re-flood, no drop).
  if (opts.undeliveredOnly) rows = rows.filter((m) => !deliveredToSelf(m.deliveredTo, selfIds))
  // Broadcast catch-up: filter '*' to the EARLIEST incarnation's start so a resume
  // still catches gap broadcasts since the metaId first appeared (deduped above).
  const starts = [Number(sRow?.started_at ?? 0), ...siblings.map((s) => Number(s.started_at ?? 0))].filter(
    (n) => n > 0,
  )
  const earliestStart = starts.length ? Math.min(...starts) : 0
  if (earliestStart > 0) {
    rows = rows.filter((m) => m.to !== '*' || m.createdAt >= earliestStart)
  }
  return rows
}

export async function markDelivered(sessionId: string, ids: string[]): Promise<void> {
  if (!sessionId || ids.length === 0) return
  await ensureBusSchema()
  const changed: string[] = []
  transaction(() => {
    for (const id of ids) {
      const cur = get<{ delivered_to?: string }>(
        `SELECT delivered_to FROM bus_messages WHERE id = ?`,
        id,
      )
      if (cur === undefined) continue
      const next = joinCsv([...splitCsv(cur.delivered_to ?? ''), sessionId])
      run(`UPDATE bus_messages SET delivered_to = ? WHERE id = ?`, next, id)
      changed.push(id)
    }
  })
  // Replicate the delivered set to peers over the mesh (local origin → undefined
  // peer tag). Emit AFTER the transaction; read back the unioned row state.
  for (const id of changed) {
    const row = get<{ delivered_to?: string; acked_by?: string; status?: string }>(
      `SELECT delivered_to, acked_by, status FROM bus_messages WHERE id = ?`,
      id,
    )
    if (row) {
      emitBusState({
        id,
        deliveredTo: splitCsv(row.delivered_to ?? ''),
        ackedBy: splitCsv(row.acked_by ?? ''),
        status: row.status ?? 'open',
      })
    }
  }
}

export async function ackMessage(
  sessionId: string,
  id: string,
  kind: 'ack' | 'done',
): Promise<void> {
  await ensureBusSchema()
  const applied = transaction(() => {
    const cur = get<{ acked_by?: string }>(`SELECT acked_by FROM bus_messages WHERE id = ?`, id)
    if (cur === undefined) return false
    const next = joinCsv([...splitCsv(cur.acked_by ?? ''), sessionId])
    const status = kind === 'done' ? 'done' : 'acked'
    run(`UPDATE bus_messages SET acked_by = ?, status = ? WHERE id = ?`, next, status, id)
    return true
  })
  // Replicate the ack to peers over the mesh (local origin → undefined peer tag).
  // Emit AFTER the transaction; read back the unioned row state. This closes the
  // ack-back gap the HTTP pull model couldn't: an ack of a peer-originated message
  // now propagates as a `state` frame.
  if (applied) {
    const row = get<{ delivered_to?: string; acked_by?: string; status?: string }>(
      `SELECT delivered_to, acked_by, status FROM bus_messages WHERE id = ?`,
      id,
    )
    if (row) {
      emitBusState({
        id,
        deliveredTo: splitCsv(row.delivered_to ?? ''),
        ackedBy: splitCsv(row.acked_by ?? ''),
        status: row.status ?? 'open',
      })
    }
  }
}

export async function listPeers(): Promise<SessionPresence[]> {
  await ensureBusSchema()
  const rows = all<Record<string, any>>(
    `${PRESENCE_SELECT} WHERE last_seen > 0 ORDER BY last_seen DESC`,
  )
  return rows.map(rowToSessionPresence)
}

// ---------------------------------------------------------------------------
// Mandate-in-presence (Item 1) — local self-stamp writes on a session's OWN row.
//
// These mutate only the calling session's presence (availability + the mandate
// provenance anchor). They are local-only (a session stamps its own row on this
// machine); the federated remote tier never owns presence, so they are NOT on
// the broker interface — routes call them directly (cf. pruneStaleSessions).
// Guardrail 2: assigned_by/assigned_ref are written here as READ-ONLY provenance
// and are never consulted by any addressing/dedup path.
// ---------------------------------------------------------------------------

/**
 * Opt a session into the orchestration pool (the /available green-light) or
 * release it after a completed assignment (done). Both resolve to
 * availability='available' with the mandate + anchor cleared. Returns null if the
 * session isn't registered yet.
 */
export async function setAvailable(sessionId: string): Promise<SessionPresence | null> {
  if (!sessionId) return null
  await ensureBusSchema()
  return transaction(() => {
    const exists = get<{ id: string }>(`SELECT id FROM session_meta WHERE id = ?`, sessionId)
    if (!exists) return null
    run(
      `UPDATE session_meta SET availability = ?, mandate = '', assigned_by = '', assigned_ref = '' WHERE id = ?`,
      AVAILABILITY.AVAILABLE,
      sessionId,
    )
    const row = get<Record<string, any>>(`${PRESENCE_SELECT} WHERE id = ?`, sessionId)
    return row ? rowToSessionPresence(row) : null
  })
}

/**
 * Self-stamp an assignment on pickup: the receiving session records the mandate
 * it's taking on + the provenance anchor (who assigned it + the dispatch msg id).
 * `mandate` defaults to a label derived from the dispatch body (deriveMandate); an
 * explicit override wins. `assignedBy` is the dispatcher's DURABLE identity (its
 * metaId, resolved from the message's from_session) so the anchor survives the
 * assigner's compact/resume. Returns null if the session or message is absent.
 *
 * Always stamps — it does NOT enforce the antibody (assist-not-enforce). The
 * coherence check is surfaced to the agent at the awareness layer BEFORE it
 * chooses to accept; the server merely records the chosen claim.
 */
export async function acceptAssignment(
  sessionId: string,
  msgId: string,
  mandateOverride?: string,
): Promise<SessionPresence | null> {
  if (!sessionId || !msgId) return null
  await ensureBusSchema()
  return transaction(() => {
    const session = get<{ id: string }>(`SELECT id FROM session_meta WHERE id = ?`, sessionId)
    if (!session) return null
    const msg = get<{ from_session: string; body: string }>(
      `SELECT from_session, body FROM bus_messages WHERE id = ?`,
      msgId,
    )
    if (!msg) return null
    // Resolve the dispatcher to its durable metaId (fall back to the raw session
    // id if it has none yet). Provenance anchor — never an addressing key (g2).
    const fromMeta = get<{ meta_id?: string }>(
      `SELECT meta_id FROM session_meta WHERE id = ?`,
      msg.from_session,
    )
    const assignedBy = String(fromMeta?.meta_id ?? '').trim() || msg.from_session
    const mandate = deriveMandate(msg.body ?? '', mandateOverride)
    run(
      `UPDATE session_meta SET availability = ?, mandate = ?, assigned_by = ?, assigned_ref = ? WHERE id = ?`,
      AVAILABILITY.ASSIGNED,
      mandate,
      assignedBy,
      msgId,
      sessionId,
    )
    const row = get<Record<string, any>>(`${PRESENCE_SELECT} WHERE id = ?`, sessionId)
    return row ? rowToSessionPresence(row) : null
  })
}

// ---------------------------------------------------------------------------
// Mesh transport (Milestone 2) — store methods backing the HTTP mesh tier.
//
// Replication is a grow-only set CRDT: immutable fields are write-once; the
// delivered_to/acked_by CSV sets are unioned; status advances monotonically
// open<acked<done (max wins). So ingest is an upsert-with-union — insert-if-new
// (preserving the SENDER's origin_node/mesh_seq), else merge — making the live
// broadcast and the /since catch-up replay converge to the same state,
// order-independently and idempotently.
// ---------------------------------------------------------------------------

/** Monotonic status rank — open < acked < done. Unknown → open (0). */
const STATUS_RANK: Record<string, number> = { open: 0, acked: 1, done: 2 }
function maxStatus(a: string, b: string): string {
  const ra = STATUS_RANK[a] ?? 0
  const rb = STATUS_RANK[b] ?? 0
  return rb > ra ? b : a
}

/**
 * Bump + read this node's monotonic originate-sequence. MUST be called inside a
 * `transaction(...)` (it's part of the atomic stamp-on-send path); a single
 * UPSERT increments and the follow-up SELECT reads the new value within the same
 * synchronous transaction, so concurrent sends can't collide on a seq.
 */
function bumpMeshSeq(node: string): number {
  run(
    `INSERT INTO mesh_seq_counter (node, seq) VALUES (?, 1) ` +
      `ON CONFLICT(node) DO UPDATE SET seq = seq + 1`,
    node,
  )
  const row = get<{ seq?: number }>(`SELECT seq FROM mesh_seq_counter WHERE node = ?`, node)
  return Number(row?.seq ?? 0)
}

/** The next monotonic per-node seq for a locally-originated message. */
export function nextMeshSeq(): number {
  return transaction(() => bumpMeshSeq(nodeId()))
}

/** The wire shape a peer sends on /api/mesh/ingest (a fully-stamped message). */
export interface MeshMessage {
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
  originNode: string
  meshSeq: number
  // humanProvenance (stage 2): the sender's honor-system marker, carried verbatim
  // across the mesh (trusted transitively, like originNode — never re-stamped).
  humanProvenance?: boolean
}

/**
 * Upsert-with-union — the heart of mesh replication. If no row with `msg.id`
 * exists, INSERT it verbatim (preserving the sender's origin_node/mesh_seq —
 * never re-stamp; this node did not originate it). Otherwise UNION the grow-only
 * sets (delivered_to/acked_by) and advance status by max-rank. Emits to the
 * local SSE channel ONLY on a fresh insert (a state-only merge must not
 * re-surface an already-seen message). Idempotent + order-independent.
 */
export function ingestMeshMessage(msg: MeshMessage, lastHopNode?: string): void {
  const inserted = transaction(() => {
    const cur = get<{ delivered_to?: string; acked_by?: string; status?: string }>(
      `SELECT delivered_to, acked_by, status FROM bus_messages WHERE id = ?`,
      msg.id,
    )
    if (cur === undefined) {
      run(
        // mesh_verified = 1: every caller of ingestMeshMessage is behind the token-
        // authed boundary (the WS Link upgrade-auth, and the bearer-gated /api/mesh
        // routes), so a row reaching here provably arrived from an authenticated
        // mesh node — the provenance trust root for m2m node-trust.
        `INSERT INTO bus_messages (id, from_session, from_name, to_addr, kind, ref, body, ` +
          `created_at, delivered_to, acked_by, status, orig_to, origin_node, mesh_seq, mesh_verified, human_provenance) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        msg.id,
        msg.fromSession,
        msg.fromName,
        msg.to,
        msg.kind,
        msg.ref,
        msg.body,
        msg.createdAt,
        joinCsv(msg.deliveredTo ?? []),
        joinCsv(msg.ackedBy ?? []),
        msg.status || 'open',
        msg.origTo ?? '',
        msg.originNode ?? '',
        Number(msg.meshSeq ?? 0),
        msg.humanProvenance ? 1 : 0,
      )
      return true
    }
    const delivered = joinCsv([...splitCsv(cur.delivered_to ?? ''), ...(msg.deliveredTo ?? [])])
    const acked = joinCsv([...splitCsv(cur.acked_by ?? ''), ...(msg.ackedBy ?? [])])
    const status = maxStatus(cur.status ?? 'open', msg.status || 'open')
    // Monotonic provenance upgrade: every ingestMeshMessage caller is behind the
    // token-authed boundary, so a re-ingest proves this row WAS received from an
    // authenticated mesh node. Set mesh_verified = 1 here too (never downgrade) so a
    // row that pre-existed unverified — a pre-roll legacy row, or one created/seen
    // before its relayed copy arrived — becomes verified regardless of arrival order.
    run(
      `UPDATE bus_messages SET delivered_to = ?, acked_by = ?, status = ?, mesh_verified = 1 WHERE id = ?`,
      delivered,
      acked,
      status,
      msg.id,
    )
    return false
  })
  if (inserted) {
    const row = get<Record<string, any>>(`${MSG_SELECT_MESH} WHERE id = ?`, msg.id)
    // Tag the emit with the LAST HOP (the peer that handed us this frame), not the
    // origin: under multi-hop relay the forwarder must avoid echoing back to the
    // immediate sender, whereas originNode would re-forward toward the origin's side.
    // Falls back to originNode for the HTTP path (sender == origin) and direct 2-node.
    if (row) emitBusMessage(rowToBusMessage(row, nodeId()), lastHopNode || msg.originNode || undefined)
  }
}

/**
 * Apply a state-only mesh event (a delivered/ack broadcast) with the same union
 * logic as ingest. No-op if `id` is unknown (the message itself will arrive via
 * ingest or catch-up and carry its own state). `status` is advanced by max-rank
 * when provided.
 *
 * `fromPeerNode` tags the peer this state arrived from so the busEvents → WS
 * forwarder doesn't echo it straight back to that peer (no loop). A state event
 * is emitted ONLY when the row's stored state actually changed — re-applying an
 * already-merged delta must not re-broadcast (would loop forever between two
 * peers each re-forwarding the other's unchanged ack).
 */
export function applyMeshState(
  id: string,
  deliveredTo: string[] = [],
  ackedBy: string[] = [],
  status?: string,
  fromPeerNode?: string,
): void {
  const changed = transaction(() => {
    const cur = get<{ delivered_to?: string; acked_by?: string; status?: string }>(
      `SELECT delivered_to, acked_by, status FROM bus_messages WHERE id = ?`,
      id,
    )
    if (cur === undefined) return false
    const delivered = joinCsv([...splitCsv(cur.delivered_to ?? ''), ...deliveredTo])
    const acked = joinCsv([...splitCsv(cur.acked_by ?? ''), ...ackedBy])
    const nextStatus = status ? maxStatus(cur.status ?? 'open', status) : (cur.status ?? 'open')
    run(
      `UPDATE bus_messages SET delivered_to = ?, acked_by = ?, status = ? WHERE id = ?`,
      delivered,
      acked,
      nextStatus,
      id,
    )
    const didChange =
      delivered !== (cur.delivered_to ?? '') ||
      acked !== (cur.acked_by ?? '') ||
      nextStatus !== (cur.status ?? 'open')
    return didChange
      ? { deliveredTo: splitCsv(delivered), ackedBy: splitCsv(acked), status: nextStatus }
      : false
  })
  if (changed) emitBusState({ id, ...changed }, fromPeerNode)
}

/**
 * Catch-up source — the messages THIS node originated with `mesh_seq > after`,
 * ordered by seq ASC, each carrying its current delivered_to/acked_by/status so
 * the receiver reconciles state too. Rows carry originNode/meshSeq (the
 * MSG_SELECT_MESH `*` projection) — the /since payload needs them verbatim.
 */
export function messagesOriginatedSince(after: number, limit = 500): BusMessageRow[] {
  const rows = all<Record<string, any>>(
    `${MSG_SELECT_MESH} WHERE origin_node = ? AND mesh_seq > ? ORDER BY mesh_seq ASC LIMIT ?`,
    nodeId(),
    after,
    limit,
  )
  // NO selfNodeId: this is the mesh-replication catch-up payload, not delivery —
  // trust is recipient-relative, so the RECEIVING node classifies on its own
  // inbox/emit. (Also avoids .map passing the array index as selfNodeId.)
  return rows.map((r) => rowToBusMessage(r))
}

/** Per-peer catch-up cursor: the highest mesh_seq this node has ingested FROM
 * `peerNode`. 0 when never synced. */
export function getCursor(peerNode: string): number {
  const row = get<{ last_seq?: number }>(
    `SELECT last_seq FROM mesh_cursors WHERE peer_node = ?`,
    peerNode,
  )
  return Number(row?.last_seq ?? 0)
}

/** Upsert the per-peer cursor to `seq`. */
export function setCursor(peerNode: string, seq: number): void {
  run(
    `INSERT INTO mesh_cursors (peer_node, last_seq, updated_at) VALUES (?, ?, ?) ` +
      `ON CONFLICT(peer_node) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
    peerNode,
    seq,
    Date.now(),
  )
}

/**
 * Read a single stored message by id, INCLUDING its mesh columns
 * (origin_node/mesh_seq via the MSG_SELECT_MESH `*` projection). The MeshBroker
 * uses this to forward a locally-sent message verbatim to peers: the local tier
 * already stamped + stored the row, so the broadcast must carry the same
 * origin_node/mesh_seq (peers preserve them on ingest, never re-stamp).
 * Returns undefined when the id is unknown.
 */
export function getMessageById(id: string): BusMessageRow | undefined {
  const row = get<Record<string, any>>(`${MSG_SELECT_MESH} WHERE id = ?`, id)
  return row ? rowToBusMessage(row) : undefined
}
