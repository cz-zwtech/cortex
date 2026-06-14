#!/usr/bin/env tsx
/**
 * ckn-threads — the s2 resume surface CLI behind /cortex-threads and
 * /cortex-continue.
 *
 *   ckn-threads list [--all] [--session <id>] [--cwd <dir>]   # open threads + claim state
 *   ckn-threads resumable [--all] ...                         # only the resume candidates
 *   ckn-threads resume [<thread-id>] ...                      # claim + print detail (/cortex-continue)
 *   ckn-threads handoff <thread-id> ...                       # release my claim (/cortex-handoff, s2b)
 *   ckn-threads hydrate <thread-id> ...                       # parallel-fetch the linked-memory back-story (resume DEPTH)
 *
 * A thread is in-flight work; a CLAIM ties it to the SESSION resuming it. `list`
 * shows every open thread annotated with this session's claim state; `resume`
 * claims one (open + not held by a live peer) and prints its next_step so the
 * model can pick up where the prior session left off — the no-`--resume` litmus.
 *
 * Dual-path (CLAUDE.md): API-first; direct-open the graph ONLY when no server is
 * bound (the claim write would otherwise contend with the server's single
 * writer). By default `list` is scoped to THIS machine's threads (claim presence
 * resolves against this machine's bus); `--all` drops the owner filter.
 */
import { isServerUp, SERVER_URL, directFallbackMode } from './_graph-guard.js'
import { resolveSelfSessionId } from './_session-id.js'
import { renderResumeHead } from './_resume-head.js'
import { hydrateLinks, renderHydrate } from './_thread-hydrate.js'

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (flag: string): boolean => process.argv.includes(flag)
const die = (msg: string): never => {
  console.error(`ckn-threads: ${msg}`)
  process.exit(1)
}

const mySession = async (): Promise<string> => {
  // Authoritative self-id resolver (transcript-first; see _session-id.ts) —
  // defeats the continue/compact bootstrap phantom rather than trusting env blindly.
  const { sessionId } = resolveSelfSessionId({
    explicit: arg('--session'),
    env: process.env.CLAUDE_CODE_SESSION_ID,
  })
  if (!sessionId) die('could not detect current session id — pass --session <id>.')
  return sessionId
}

interface ThreadWire {
  id: string
  name: string
  description: string
  ownerMachine: string
  claimState: 'pending' | 'claimed-mine' | 'claimed-other'
  state: { status: string; nextStep: string; links: string[]; repo?: string; branch?: string; pushed?: boolean }
}

// ── data access: API when the server is up, else a direct graph open ──────────

const ownerFilter = async (): Promise<string | undefined> => {
  if (has('--all')) return undefined
  const { getMachineId } = await import('../server/privateMind.js')
  return getMachineId()
}

const fetchThreads = async (session: string, resumable: boolean): Promise<ThreadWire[]> => {
  const owner = await ownerFilter()
  if (await isServerUp()) {
    const qs = new URLSearchParams({ session })
    if (owner) qs.set('owner', owner)
    if (resumable) qs.set('resumable', '1')
    const r = await fetch(`${SERVER_URL}/api/graph/threads?${qs}`)
    if (!r.ok) die(`GET /threads -> ${r.status} ${await r.text()}`)
    return ((await r.json()) as { threads: ThreadWire[] }).threads
  }
  if ((await directFallbackMode()) === 'fail-loud') die('server up but API unreachable — refusing to direct-open.')
  const { listThreadsWithClaim, resumableThreads, OPEN_STATUSES } = await import('../server/graph/threads.js')
  const now = Date.now()
  return (
    resumable
      ? resumableThreads(session, now, { ownerMachine: owner })
      : listThreadsWithClaim(session, now, { ownerMachine: owner, statuses: OPEN_STATUSES })
  ) as ThreadWire[]
}

const claim = async (session: string, id: string): Promise<{ thread: ThreadWire; claimState: string } | null> => {
  if (await isServerUp()) {
    const r = await fetch(`${SERVER_URL}/api/graph/threads/${encodeURIComponent(id)}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session }),
    })
    if (r.status === 404) return null
    if (!r.ok) die(`POST claim -> ${r.status} ${await r.text()}`)
    return (await r.json()) as { thread: ThreadWire; claimState: string }
  }
  if ((await directFallbackMode()) === 'fail-loud') die('server up but API unreachable — refusing to direct-open.')
  const { resolveThreadRef, claimThread, threadClaimState } = await import('../server/graph/threads.js')
  const thread = resolveThreadRef(id)
  if (!thread) return null
  const now = Date.now()
  claimThread(thread.id, session, now)
  return { thread: thread as unknown as ThreadWire, claimState: threadClaimState(thread.id, session, now) }
}

const release = async (session: string, id: string): Promise<{ thread: ThreadWire; claimState: string } | null> => {
  if (await isServerUp()) {
    const r = await fetch(`${SERVER_URL}/api/graph/threads/${encodeURIComponent(id)}/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session }),
    })
    if (r.status === 404) return null
    if (!r.ok) die(`POST release -> ${r.status} ${await r.text()}`)
    return (await r.json()) as { thread: ThreadWire; claimState: string }
  }
  if ((await directFallbackMode()) === 'fail-loud') die('server up but API unreachable — refusing to direct-open.')
  const { resolveThreadRef, releaseThread, threadClaimState } = await import('../server/graph/threads.js')
  const thread = resolveThreadRef(id)
  if (!thread) return null
  const now = Date.now()
  releaseThread(thread.id, session, now)
  return { thread: thread as unknown as ThreadWire, claimState: threadClaimState(thread.id, session, now) }
}

// Fetch ONE linked memory's content by slug (API): search → exact-name entry →
// node content. Returns null when the slug has no graph entry (an unwritten
// forward-link). Used by `hydrate`, fanned out in parallel by hydrateLinks.
const fetchLinkContent = async (slug: string): Promise<{ description?: string; body?: string } | null> => {
  const sr = await fetch(`${SERVER_URL}/api/graph/search?q=${encodeURIComponent(slug)}`)
  if (!sr.ok) return null
  const { entries } = (await sr.json()) as { entries: { id: string; name: string }[] }
  const hit = entries.find((e) => e.name === slug)
  if (!hit) return null
  // /node/:id(*) takes the raw id (slashes included) — do NOT encode the slashes.
  const nr = await fetch(`${SERVER_URL}/api/graph/node/${hit.id}`)
  if (!nr.ok) return null
  const node = (await nr.json()) as { description?: string; content?: string }
  return { description: node.description, body: node.content }
}

const matchesRef = (t: ThreadWire, ref: string): boolean =>
  t.id === ref || t.id === `thread:${ref}` || t.id.endsWith('/' + ref) || t.name === ref

// ── presentation ──────────────────────────────────────────────────────────────

const tag = (s: string): string =>
  s === 'claimed-mine' ? '[mine]   ' : s === 'claimed-other' ? '[peer]   ' : '[pending]'

const printList = (threads: ThreadWire[], header: string) => {
  console.log(`${header} — ${threads.length}`)
  for (const t of threads) {
    const repo = t.state.repo ? `  (${t.state.repo}${t.state.branch ? `@${t.state.branch}` : ''})` : ''
    console.log(`${tag(t.claimState)} ${t.id}${repo}`)
    console.log(`           ${t.state.nextStep || t.description || '(no next step recorded)'}`)
  }
}

// The resume HEAD + a CODE-enforced STOP guard (renderResumeHead): print the
// head, hand control back — never auto-run next_step. See _resume-head.ts.
const printDetail = (thread: ThreadWire, claimState: string) => {
  console.log(renderResumeHead(thread, claimState))
}

// ── main ────────────────────────────────────────────────────────────────────

const main = async () => {
  const cmd = process.argv[2] ?? 'list'
  const session = await mySession()

  if (cmd === 'list' || cmd === 'resumable') {
    const threads = await fetchThreads(session, cmd === 'resumable')
    const scope = has('--all') ? 'all machines' : 'this machine'
    printList(threads, cmd === 'resumable' ? `RESUMABLE THREADS (${scope})` : `OPEN THREADS (${scope})`)
    return
  }

  if (cmd === 'resume') {
    let id = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined
    if (!id) {
      // No id given: auto-pick when there's exactly one candidate; otherwise list.
      const cands = await fetchThreads(session, true)
      if (cands.length === 0) {
        console.log('No resumable threads (nothing open + unclaimed for you).')
        return
      }
      if (cands.length > 1) {
        printList(cands, 'RESUMABLE THREADS — pass an id to resume one')
        return
      }
      id = cands[0].id
    }
    const result = await claim(session, id)
    if (!result) die(`no thread '${id}' (or it is not a thread).`)
    printDetail(result.thread, result.claimState)
    return
  }

  if (cmd === 'handoff' || cmd === 'release') {
    const ref = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined
    if (!ref) die(`${cmd}: a thread ref is required (handoff <thread-id-or-slug>).`)
    const result = await release(session, ref)
    if (!result) die(`no thread '${ref}' (or it is not a thread).`)
    console.log(`HANDED OFF ${result.thread.id} → ${result.claimState}`)
    console.log(`A peer can now resume it (/cortex-continue ${result.thread.id}).`)
    return
  }

  if (cmd === 'hydrate') {
    const ref = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined
    if (!ref) die('hydrate: a thread ref is required (hydrate <thread-id-or-slug>).')
    if (!(await isServerUp())) die('hydrate needs the Cortex server — start it with ckn-start.')
    // Resume-UX DEPTH: fetch the thread's linked memories IN PARALLEL (the
    // "how did we get here?" back-story) so the main session stays responsive.
    const threads = await fetchThreads(session, false)
    const t = threads.find((x) => matchesRef(x, ref!))
    if (!t) die(`no open thread '${ref}' for this machine (try --all, or pass the full id).`)
    const results = await hydrateLinks(t!.state.links, fetchLinkContent)
    console.log(renderHydrate({ id: t!.id, nextStep: t!.state.nextStep }, results))
    return
  }

  if (cmd === 'mode') {
    // mode-on-claim (#89): declare the work mode on this session's open claim AT the
    // transition, so PostCompact can re-evaluate whether resume is safe.
    const ref = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined
    const mode = process.argv[4]
    if (!ref || !mode)
      die(
        'mode: usage — mode <thread> <working|quiesced|waiting-on:thread=<id>:status=<x>|waiting-on:bus=<msgid>>',
      )
    if (!(await isServerUp())) die('mode needs the Cortex server — start it with ckn-start.')
    const r = await fetch(`${SERVER_URL}/api/graph/threads/${encodeURIComponent(ref!)}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, mode }),
    })
    if (r.status === 404) die(`no thread '${ref}'.`)
    if (!r.ok) die(`POST mode -> ${r.status} ${await r.text()}`)
    console.log(`MODE ${ref} → ${mode}`)
    return
  }

  die(
    `unknown command '${cmd}' — use list | resumable | resume [<id>] | handoff <id> | hydrate <id> | mode <id> <mode>.`,
  )
}

main().catch((e) => die(e?.message ?? String(e)))
