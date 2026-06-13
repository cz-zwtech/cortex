#!/usr/bin/env tsx
/**
 * ckn-bus — session-to-session communication CLI over the Cortex server.
 *
 * API-ONLY: the server must be the writer (it owns the single SQLite writer).
 * If the server is down, this prints a clear message and exits non-zero — it
 * never direct-opens the graph.
 *
 *   ckn-bus peers
 *   ckn-bus send --to <name|id|*> --body "text" [--from <id>] [--ref <msgid>] [--kind msg|reply] [--human]
 *   ckn-bus inbox [--session <id>] [--all]
 *   ckn-bus ack --id <msgid> [--session <id>] [--done]
 *   ckn-bus reply --ref <msgid> --to <name|id> --body "text" [--from <id>] [--human]
 *     (--human = humanProvenance: a HUMAN directed this send; on a trusted source
 *      it marks the human's DIRECT instruction. Honor-system; default off.)
 *   ckn-bus whoami [--session <id>]
 *   ckn-bus watch [--session <id>]    # poll loop, one stdout line per new message (for Monitor)
 *   ckn-bus prune                     # remove stale presence rows (signed_off >24h / any >30d)
 *   ckn-bus available [--session <id>]               # opt into the orchestration pool (the green-light)
 *   ckn-bus accept <msgId> [--mandate "role: scope"] # self-stamp a coordinator's dispatch on pickup
 *   ckn-bus done [--session <id>]                    # release the assignment, back to available
 */
import { isServerUp, SERVER_URL } from './_graph-guard.js'
import { resolveSelfSessionId, localTranscriptIds } from './_session-id.js'
import { resolveRecipient, type Peer } from './_resolve-recipient.js'
import {
  watcherShouldExit,
  heartbeatTouch,
  HEARTBEAT_S,
  formatBusLine,
  scanWatcherProcs,
  survivorAdoptPids,
  selfAncestryPids,
  procStartTicks,
} from './_bus-watch.js'
import { paginateBody, DEFAULT_PAGE_LIMIT, reassembleList, PageReassembler } from './_bus-paginate.js'

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (flag: string): boolean => process.argv.includes(flag)

const die = (msg: string): never => {
  console.error(`ckn-bus: ${msg}`)
  process.exit(1)
}

const ensureServer = async () => {
  if (!(await isServerUp())) die('Cortex server not running on :3001 — start it with ckn-start.')
}

const post = async (path: string, body: any): Promise<any> => {
  const r = await fetch(`${SERVER_URL}/api/bus${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) die(`${path} -> ${r.status} ${await r.text()}`)
  return r.json() as Promise<any>
}
const get = async (path: string): Promise<any> => {
  const r = await fetch(`${SERVER_URL}/api/bus${path}`)
  if (!r.ok) die(`${path} -> ${r.status} ${await r.text()}`)
  return r.json() as Promise<any>
}

// Monotonic-ish unique group id for a paginated send (this process). Random
// suffix avoids collision across concurrent senders; bin scripts may use
// Date.now/Math.random (unlike Workflow scripts).
let _gidSeq = 0
const newGroupId = (): string =>
  `${Date.now().toString(36)}-${(_gidSeq++).toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`

/**
 * Send a body, splitting it into mesh-safe parts (a shared groupId via the
 * body-header) when it exceeds the page limit; a short body sends as one
 * message unchanged. Each part is a normal /send so older nodes still read it;
 * the recipient's read surfaces reassemble. Returns the part ids in order.
 */
const sendBody = async (payload: Record<string, unknown>, body: string): Promise<string[]> => {
  const parts = paginateBody(body, newGroupId(), DEFAULT_PAGE_LIMIT)
  const ids: string[] = []
  for (const part of parts) {
    const r = await post('/send', { ...payload, body: part })
    ids.push(r.id)
  }
  return ids
}

// Recipient name-resolution lives in _resolve-recipient.ts (testable without the
// CLI). It needs a same-machine transcript predicate to break LIVE name ties —
// memoized so the FS scan happens at most once, only when a tie actually occurs.
let _localTx: Set<string> | null = null
const isLocalTranscript = (sessionId: string): boolean =>
  (_localTx ??= localTranscriptIds()).has(sessionId)

const recipientOpts = { die, isLocalTranscript }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ACK_TIMEOUT_MS = Number(process.env.CKN_BUS_ACK_TIMEOUT_MS ?? '4000')
const PROBE_TIMEOUT_MS = Number(process.env.CKN_BUS_PROBE_TIMEOUT_MS ?? '8000')
const POLL_MS = 700

/**
 * Poll my inbox (incl. delivered) for an ack/reply whose `ref` is in `refIds`.
 * Returns the first matching message, or undefined on timeout. Marks scanned
 * acks delivered so they don't re-surface in the normal prompt-boundary floor.
 */
const waitForAck = async (
  session: string,
  refIds: Set<string>,
  timeoutMs: number,
): Promise<any | undefined> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { messages } = await get(`/inbox?session=${encodeURIComponent(session)}&all`)
    const hit = messages.find(
      (m: any) => (m.kind === 'ack' || m.kind === 'done' || m.kind === 'reply') && refIds.has(m.ref),
    )
    if (hit) return hit
    await sleep(POLL_MS)
  }
  return undefined
}

/**
 * Marco-polo: send a targeted message and wait for an ack. On silence, escalate
 * to a broadcast probe so a renamed/relocated intended peer (or any peer that
 * can act) can answer. Returns a verdict the caller reports.
 */
const sendWithAck = async (
  from: string,
  fromName: string,
  to: string,
  body: string,
  origLabel: string,
): Promise<{ status: 'acked' | 'probe-acked' | 'unreachable'; via?: any; msgId: string; probeId?: string }> => {
  const sent = await post('/send', { fromSession: from, fromName, to, body, kind: 'msg' })
  console.log(`sent ${sent.id} → ${to} (awaiting ack ${ACK_TIMEOUT_MS}ms)`)
  const ack = await waitForAck(from, new Set([sent.id]), ACK_TIMEOUT_MS)
  if (ack) return { status: 'acked', via: ack, msgId: sent.id }

  // Escalate — broadcast a probe carrying the original target.
  console.log(`no ack — escalating to broadcast probe (marco-polo) for '${origLabel}'…`)
  const probe = await post('/send', {
    fromSession: from,
    fromName,
    to: '*',
    kind: 'probe',
    ref: sent.id,
    origTo: origLabel,
    body: `marco-polo probe: are you '${origLabel}'? (orig msg ${sent.id}) — ${body}`,
  })
  const pack = await waitForAck(from, new Set([sent.id, probe.id]), PROBE_TIMEOUT_MS)
  if (pack) return { status: 'probe-acked', via: pack, msgId: sent.id, probeId: probe.id }
  return { status: 'unreachable', msgId: sent.id, probeId: probe.id }
}

const mySession = async (): Promise<string> => {
  // Authoritative self-id resolver (transcript-first): explicit override →
  // candidate (env) validated by its own transcript → newest actively-appended
  // transcript → env fallback. Defeats the continue/compact bootstrap PHANTOM
  // (an artifact-dir uuid with no transcript) instead of trusting env blindly.
  const { sessionId } = resolveSelfSessionId({
    explicit: arg('--session') ?? arg('--from'),
    env: process.env.CLAUDE_CODE_SESSION_ID,
  })
  if (!sessionId) die('could not detect current session id — pass --session <id>.')
  return sessionId
}

const main = async () => {
  const cmd = process.argv[2]
  await ensureServer()
  switch (cmd) {
    case 'peers': {
      const { peers } = await get('/peers')
      for (const p of peers) {
        console.log(
          `${p.status.padEnd(10)} ${p.friendlyName.padEnd(20)} ${(p.machine || '?').padEnd(14)} ${p.cwd}  (${p.sessionId.slice(0, 8)})`,
        )
      }
      break
    }
    case 'send': {
      const toArg = arg('--to') ?? die('send: --to required')
      const body = arg('--body') ?? die('send: --body required')
      const from = await mySession()
      const { peers } = await get('/peers')
      const me = peers.find((p: Peer) => p.sessionId === from)
      const fromName = me?.friendlyName ?? ''
      const to = resolveRecipient(toArg, peers, me?.machine ?? '', recipientOpts)
      // --expect-ack turns on the marco-polo loop: wait for an ack, escalate to a
      // broadcast probe on silence. Only meaningful for a targeted (non-'*') send.
      if (has('--expect-ack') && to !== '*') {
        const verdict = await sendWithAck(from, fromName, to, body, toArg)
        if (verdict.status === 'acked') {
          console.log(`✓ acked by ${verdict.via.fromName || verdict.via.fromSession?.slice(0, 8)}`)
        } else if (verdict.status === 'probe-acked') {
          const v = verdict.via
          console.log(
            `✓ probe answered by ${v.fromName || v.fromSession?.slice(0, 8)} ` +
              `(metaId ${v.fromSession ? '' : ''}${v.body ? '' : ''}) — '${toArg}' is reachable under that identity. ` +
              `Re-address future messages to its session/metaId.`,
          )
          console.log(`  response: ${v.body}`)
        } else {
          console.log(`✗ UNREACHABLE: no ack for '${toArg}' and no peer claimed the probe. It may be offline.`)
        }
        break
      }
      const ids = await sendBody(
        { fromSession: from, fromName, to, kind: arg('--kind') ?? 'msg', ref: arg('--ref') ?? '', humanProvenance: has('--human') },
        body,
      )
      const label = ids.length === 1 ? ids[0] : `${ids.length} parts (${ids[0]}…)`
      console.log(`sent ${label} → ${to}${has('--human') ? ' (human-directed)' : ''}`)
      break
    }
    case 'probe': {
      // Marco-polo on demand: find whether an address is reachable, following
      // renames. Always escalates to a broadcast probe after the targeted try.
      const toArg = arg('--to') ?? die('probe: --to required')
      const body = arg('--body') ?? `ping — are you '${toArg}'?`
      const from = await mySession()
      const { peers } = await get('/peers')
      const me = peers.find((p: Peer) => p.sessionId === from)
      const fromName = me?.friendlyName ?? ''
      const to = resolveRecipient(toArg, peers, me?.machine ?? '', recipientOpts)
      const verdict = await sendWithAck(from, fromName, to, body, toArg)
      console.log(JSON.stringify({ target: toArg, ...verdict, via: verdict.via?.fromSession }, null, 2))
      break
    }
    case 'reply': {
      const ref = arg('--ref') ?? die('reply: --ref required')
      const toArg = arg('--to') ?? die('reply: --to required')
      const body = arg('--body') ?? die('reply: --body required')
      const from = await mySession()
      const { peers } = await get('/peers')
      const me = peers.find((p: Peer) => p.sessionId === from)
      const fromName = me?.friendlyName ?? ''
      const to = resolveRecipient(toArg, peers, me?.machine ?? '', recipientOpts)
      const ids = await sendBody(
        { fromSession: from, fromName, to, kind: 'reply', ref, humanProvenance: has('--human') },
        body,
      )
      const label = ids.length === 1 ? ids[0] : `${ids.length} parts (${ids[0]}…)`
      console.log(`replied ${label} (re: ${ref})${has('--human') ? ' (human-directed)' : ''}`)
      break
    }
    case 'inbox': {
      const session = await mySession()
      // --all re-shows watcher-CONSUMED records too (the watcher marks messages
      // delivered as it surfaces them, so the default undelivered-only view is empty
      // for an armed-watcher session). The server-asserted `trust` verdict is
      // surfaced here as the readable record — same token as the watcher line + the
      // <inter-session-message> wrapper, so node-trust reads identically everywhere.
      const { messages } = await get(`/inbox?session=${encodeURIComponent(session)}${has('--all') ? '' : '&undeliveredOnly=1'}`)
      // Reassemble paginated groups into whole messages before rendering, so a
      // long peer message reads as one record, not [[ckn-page]] fragments.
      const reassembled = reassembleList<any>(messages)
      // Working view de-noises ack/done confirmations (stage 3A); --all shows them.
      const shown = has('--all')
        ? reassembled
        : reassembled.filter((m: any) => m.kind !== 'ack' && m.kind !== 'done')
      const acksHidden = reassembled.length - shown.length
      for (const m of shown) {
        const trust = m.trust ?? (m.meshVerified ? 'mesh' : 'unverified')
        const base = trust === 'mesh' ? `trust=mesh origin=${m.originNode || '?'}` : `trust=${trust}`
        const prov = base + (m.humanProvenance ? ' human' : '')
        console.log(`[${m.id} ${prov}] ${m.fromName || m.fromSession.slice(0, 8)} → ${m.to}${m.ref ? ` (re: ${m.ref})` : ''}: ${m.body}`)
      }
      if (shown.length === 0) console.log('(no messages)')
      if (acksHidden > 0) console.log(`(${acksHidden} ack/done hidden — ckn-bus inbox --all to show)`)
      break
    }
    case 'ack': {
      const id = arg('--id') ?? die('ack: --id required')
      const session = await mySession()
      await post('/ack', { sessionId: session, id, kind: has('--done') ? 'done' : 'ack' })
      console.log(`acked ${id}${has('--done') ? ' (done)' : ''}`)
      break
    }
    // ── mandate-in-presence (Item 1): orchestration availability + assignment ──
    case 'available': {
      // The green-light: opt this session into the orchestration pool. Distinct
      // from mere presence (auto-announced) — a session is not dispatch-eligible
      // until it explicitly declares itself available for coordinated work.
      const session = await mySession()
      const { presence } = await post('/available', { sessionId: session })
      console.log(`available for orchestration — ${presence.friendlyName} (${presence.sessionId.slice(0, 8)})`)
      break
    }
    case 'accept': {
      // Self-stamp a coordinator's dispatch on pickup. Mandate is derived from the
      // dispatch by default; --mandate overrides with an explicit "role: scope".
      const msgId = process.argv[3]
      if (!msgId || msgId.startsWith('--')) {
        die('accept: usage: ckn-bus accept <msgId> [--mandate "role: scope"]')
      }
      const session = await mySession()
      const mandate = arg('--mandate')
      const { presence } = await post('/accept', {
        sessionId: session,
        msgId,
        ...(mandate != null ? { mandate } : {}),
      })
      console.log(
        `assigned — "${presence.mandate}" (anchor ${String(presence.assignedRef).slice(0, 8)} from ${String(presence.assignedBy).slice(0, 12)})`,
      )
      break
    }
    case 'done': {
      // Release the current assignment — back into the available pool.
      const session = await mySession()
      const { presence } = await post('/done', { sessionId: session })
      console.log(`released — available for orchestration (${presence.sessionId.slice(0, 8)})`)
      break
    }
    case 'whoami': {
      const session = await mySession()
      const { peers } = await get('/peers')
      const me = peers.find((p: any) => p.sessionId === session)
      console.log(me ? `${me.friendlyName} (${me.sessionId.slice(0, 8)}) — ${me.status}` : `unregistered session ${session.slice(0, 8)}`)
      break
    }
    case 'watch': {
      const session = await mySession()

      // #40 B+ compact-survivor adopt: a pre-compact `ckn-bus watch` survives a
      // /compact, so arming a fresh watcher on resume can leave TWO watchers on one
      // session. Reap any OTHER watcher bound to MY (resolver-derived) session id so
      // a session never runs two — the situation that, with the old signoff-on-bail,
      // cascaded a live session to signed_off. Safe now: bail() no longer signs off,
      // so killing the survivor just stops it. EXCLUDE my full ancestor chain — the
      // Monitor bash/npx/tsx layers all match scanWatcherProcs, so reaping by leaf
      // pid alone SIGTERMed my own parents (the live-dogfood self-ancestor-kill). And
      // reap only PROVABLY-older procs (starttime) so a same-instant arm can't mutual-
      // kill to zero. Best-effort (Linux /proc only).
      try {
        const procs = scanWatcherProcs()
        const ancestry = selfAncestryPids()
        const reap = survivorAdoptPids(ancestry, procStartTicks(process.pid), session, procs)
        if (process.argv.includes('--check-adopt')) {
          // Dry-run diagnostic (no kill, no watch loop) — LIVE-validates the adopt
          // against the REAL /proc tree before trusting it, since tree topology is
          // invisible to unit tests (the self-ancestor-kill lesson). `wouldReap`
          // must NEVER contain a pid from `ancestry`.
          console.log(
            JSON.stringify(
              {
                myPid: process.pid,
                session: session.slice(0, 8),
                ancestry,
                scannedForMySession: procs.filter((p) => p.sessionId === session).map((p) => p.pid),
                wouldReap: reap,
              },
              null,
              2,
            ),
          )
          process.exit(0)
        }
        for (const pid of reap) {
          try {
            process.kill(pid, 'SIGTERM')
            console.error(
              `[bus-watch] adopted session ${session.slice(0, 8)} — reaped surviving watcher pid ${pid}`,
            )
          } catch {
            /* already gone — fine */
          }
        }
      } catch {
        /* no /proc or scan failed — non-fatal; the server's startup reaper backstops */
      }

      // Self-exit guards so a watcher never outlives its session — the
      // teardown-gap leak where orphaned watch subtrees from prior sessions
      // pile up node RSS (feeds the box's memory pressure → segfaults).
      //   (1) prompt exit on SIGTERM/SIGINT — Monitor teardown / TaskStop;
      //   (2) exit once our OWN session is signed_off on the bus, DEBOUNCED
      //       (the clean SessionEnd case). See _bus-watch.ts for the rationale.
      // The bounded heartbeat interval — declared here so bail() can clear it on
      // EVERY exit path (signal teardown AND the signed_off self-exit guard).
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let bailing = false
      // #40 B+ — a watcher is a DELIVERY CHANNEL, NOT the session's lifecycle
      // owner, so bail() NEVER signs the session off. Signing off on a watcher's
      // SIGTERM cascaded a LIVE session to signed_off whenever one of N watchers
      // was killed (e.g. reaping a /compact-survivor duplicate), which then made
      // the sibling watchers self-exit. Session signoff belongs to ckn-extract
      // (SessionEnd) for a clean /exit + the stale-prune/startup-reaper for abrupt
      // deaths. bail() just clears the heartbeat and exits — which still fixes the
      // orphan-RSS leak (the process actually stops).
      // ACCEPTED REGRESSION: an ABRUPT terminal death (no SessionEnd, e.g. SIGKILL)
      // loses the instant "left" signoff the old signoff-before-bail gave; peers
      // now see the session go idle (5 min) → stale via prune — the presence ladder
      // exists for exactly this. Synchronous + guarded by `bailing` (never re-runs).
      const bail = (why: string): void => {
        if (bailing) return
        bailing = true
        console.error(`[bus-watch] ${why} — exiting (session ${session.slice(0, 8)})`)
        if (heartbeat) clearInterval(heartbeat)
        process.exit(0)
      }
      process.on('SIGTERM', () => void bail('SIGTERM'))
      process.on('SIGINT', () => void bail('SIGINT'))
      let sawSelfLive = false
      // Consecutive signed_off poll observations — drives the debounced self-exit
      // guard (r1) so a transient signed_off during a /compact self-heal revive
      // doesn't kill a live watcher. Reset to 0 on any non-signed_off read.
      let signedOffStreak = 0
      // My alias set (sessionId, metaId, current name, retired names) — used to
      // decide whether a broadcast probe is asking for ME (auto-ack = the "polo").
      const aliasSet = new Set<string>([session])
      const refreshAliases = async () => {
        try {
          const { peers } = await get('/peers')
          const me = peers.find((p: Peer) => p.sessionId === session)
          if (me && me.status !== 'signed_off') sawSelfLive = true
          signedOffStreak = me?.status === 'signed_off' ? signedOffStreak + 1 : 0
          if (watcherShouldExit(me, sawSelfLive, signedOffStreak)) {
            bail('session signed off')
            return
          }
          aliasSet.clear()
          aliasSet.add(session)
          if (me?.metaId) aliasSet.add(me.metaId)
          if (me?.friendlyName) aliasSet.add(me.friendlyName)
          for (const n of me?.nameHistory ?? []) aliasSet.add(n)
        } catch {
          /* keep prior alias set */
        }
      }

      const seen = new Set<string>()
      // Streaming page-reassembler: a paginated part is buffered (not surfaced)
      // until its group completes, so a long message shows as one line + one ack.
      const pageReassembler = new PageReassembler<any>()

      // The single per-message handler shared by the SSE stream (instant) and the
      // poll loop (fallback). Dedupes via `seen`, logs the line, auto-acks/polos a
      // targeted message or a probe-for-me, and marks it delivered. Idempotent:
      // whichever path sees a message first wins; the other skips it via `seen`.
      const handleMessage = async (m: any): Promise<void> => {
        if (!m || !m.id || seen.has(m.id)) return
        seen.add(m.id)
        // Page-reassembly: buffer a paginated part until its group completes. A
        // buffered part is consumed (marked delivered) but not surfaced; the whole
        // message surfaces + auto-acks ONCE when the final part lands.
        const whole = pageReassembler.offer(m)
        if (!whole) {
          try { await post('/delivered', { sessionId: session, ids: [m.id] }) } catch { /* part consumed; poll covers a miss */ }
          return
        }
        m = whole
        // De-noise the decision surface: ack/done confirmations ("received,
        // acting.") are not actionable and bury real messages. Suppress them from
        // the firehose by default (still in `ckn-bus inbox --all`); CKN_BUS_WATCH_ACKS=1
        // to show. The auto-ack logic below already excludes ack/done. We still fall
        // through to mark them delivered so they're consumed + eligible to expire.
        const isAck = m.kind === 'ack' || m.kind === 'done'
        const showAcks = (process.env.CKN_BUS_WATCH_ACKS ?? '') === '1'
        if (!isAck || showAcks) {
          // Front-load provenance (trust/originNode) so a session reading this
          // real-time line can evaluate m2m node-trust — the stamp is on both the
          // poll (MSG_SELECT_INBOX) and SSE (MSG_SELECT_MESH `*`) surfaces.
          console.log(formatBusLine(m))
        }
        // Auto-ack ("polo"): a targeted (non-'*', non-ack) message that matched a
        // concrete alias, OR a probe whose origTo is one of my aliases.
        const isProbe = m.kind === 'probe'
        const targeted = m.to !== '*' && m.kind !== 'ack' && m.kind !== 'done'
        const probeForMe = isProbe && m.origTo && aliasSet.has(m.origTo)
        if ((targeted && !isProbe) || probeForMe) {
          try {
            const myMeta = [...aliasSet].find((a) => a.startsWith('meta_')) ?? session
            await post('/send', {
              fromSession: session,
              fromName: session.slice(0, 8),
              to: m.fromSession,
              kind: 'ack',
              ref: m.id,
              body: probeForMe ? `polo — yes, I'm '${m.origTo}' (metaId ${myMeta}). Acting.` : 'received, acting.',
            })
          } catch {
            /* best-effort ack */
          }
        }
        try {
          await post('/delivered', { sessionId: session, ids: m.partIds ?? [m.id] })
        } catch {
          /* best-effort — the poll's delivered call covers a miss */
        }
      }

      // SSE stream: subscribe to /api/bus/stream for instant surfacing. The server
      // pushes any message landing for one of my aliases (locally sent OR
      // mesh-ingested from a peer), so I don't wait for the next poll tick. The
      // stream is best-effort; on error we reconnect with backoff and the poll
      // loop carries delivery in the meantime.
      const streamLoop = async () => {
        let backoff = 1000
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            const r = await fetch(`${SERVER_URL}/api/bus/stream?session=${encodeURIComponent(session)}`, {
              headers: { Accept: 'text/event-stream' },
            })
            if (!r.ok || !r.body) throw new Error(`stream -> ${r.status}`)
            backoff = 1000 // a successful connect resets the backoff
            const reader = r.body.getReader()
            const decoder = new TextDecoder()
            let buf = ''
            // eslint-disable-next-line no-constant-condition
            while (true) {
              const { value, done } = await reader.read()
              if (done) break
              buf += decoder.decode(value, { stream: true })
              // Frames are separated by a blank line; a `data:` frame carries the
              // JSON message. `:`-prefixed lines are comments/keep-alive pings.
              let nl: number
              while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).replace(/\r$/, '')
                buf = buf.slice(nl + 1)
                if (line.startsWith('data:')) {
                  const payload = line.slice('data:'.length).trim()
                  if (payload) {
                    try {
                      await handleMessage(JSON.parse(payload))
                    } catch {
                      /* malformed frame — ignore, poll covers it */
                    }
                  }
                }
              }
            }
          } catch {
            /* connection dropped/refused — fall through to backoff + reconnect */
          }
          await sleep(backoff)
          backoff = Math.min(backoff * 2, 15000)
        }
      }

      await refreshAliases()
      const prime = await get(`/inbox?session=${encodeURIComponent(session)}&undeliveredOnly=1`)
      for (const m of prime.messages) seen.add(m.id)

      // Kick off the SSE stream in the background; it never resolves (loops).
      void streamLoop()

      // Bounded liveness heartbeat: bump last_seen + record the cadence every
      // HEARTBEAT_S so a consumer (e.g. the PM) can apply its own N×cadence
      // staleness. Cleared by bail() on every exit path. Fire one immediately so
      // cadence_s is set on the first beat, not HEARTBEAT_S later.
      heartbeat = setInterval(() => { void heartbeatTouch(SERVER_URL, session) }, HEARTBEAT_S * 1000)
      void heartbeatTouch(SERVER_URL, session)

      // Poll loop, slowed to ~3s as a safety net: it refreshes the alias set
      // (rename pickup) and drives the self-signoff exit guard every tick, and
      // catches anything the stream missed (e.g. during a reconnect window).
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await refreshAliases() // also runs the signed_off exit guard
          const { messages } = await get(`/inbox?session=${encodeURIComponent(session)}&undeliveredOnly=1`)
          for (const m of messages) await handleMessage(m)
        } catch {
          // transient server blip — keep watching
        }
        await sleep(3000)
      }
    }
    case 'prune': {
      // On-demand cleanup of stale presence rows (signed_off >24h, or any status
      // >30d). API-first like the rest of the CLI — the server owns the writer.
      // Reversible: a real --resume re-touches a pruned session back into peers.
      const { pruned } = await post('/prune-sessions', {})
      console.log(`pruned ${pruned} stale session presence row(s)`)
      break
    }
    case 'mesh': {
      // m2m-gate diagnostics: peer reachability + per-peer cursors + the gossiped
      // fleet view. Reads local mesh state (not token-gated).
      const status = await get('/mesh-status')
      console.log(JSON.stringify(status, null, 2))
      // FR-7 I5: surface direct-link hints (loopback-only + unreachable peers) below
      // the dump so they aren't lost in the JSON.
      const hints = (status as { hints?: string[] }).hints ?? []
      for (const h of hints) console.log(`\n⚠ hint: ${h}`)
      break
    }
    default:
      die(`unknown command '${cmd ?? ''}'. Try: peers | send | probe | reply | inbox | ack | whoami | watch | prune | mesh | available | accept | done`)
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)))
