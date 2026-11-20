import type { ModuleCtx } from '../../../core/ctx.js'
import type { SubscriberResponse } from '../../../core/aggregate.js'
import { addReminder, takeReminderNote } from '../../../core/pendingReminders.js'
import { cliPath, deliveryText, metaFor, notMemberText, openComms, resolveMember, type HookPayload } from './session.js'
import { completeHeld, heldRenames } from './renames.js'
import type { Comms } from './comms.js'
import type { LocalIdentity } from './identity.js'
import {
  isHeadless,
  lapseText,
  lastPromptAt,
  recordPrompt,
  STAND_DOWN_MS,
  standDown,
  stopShouldHold,
  takeReminder,
  takeStopBlock,
  watchStatus,
  type WatchStatus,
} from './watchState.js'
import { isVerbose } from './verbose.js'

/**
 * Shared body of the two hook handlers. Both events carry `session_title`, and
 * both can set it, so both resolve identity the same way; they differ only in
 * what they say.
 *
 * Fails open: if the bus is unreachable the session runs normally and the
 * reason goes to stderr through ctx.log. A messaging feature that can break a
 * coding session is worse than no messaging feature.
 */
export const handle = async (
  payload: unknown,
  ctx: ModuleCtx,
  event: 'SessionStart' | 'UserPromptSubmit',
  open: (dataDir: string) => { local: LocalIdentity; comms: Comms } = openComms,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubscriberResponse> => {
  const p = (payload ?? {}) as HookPayload
  // Subagents and headless runs (claude -p, the SDK) cannot keep a watcher and
  // must not be told to: a one-turn judgement that reaches for Monitor fails.
  if (p.agent_id || isHeadless(env)) return undefined
  const { local, comms } = open(ctx.dataDir)

  try {
    const r = await resolveMember(p, local, comms, env)
    const pending = local.takePendingTitle(p.session_id)
    if (!r.member) {
      const response: Record<string, string> = {}
      if (event === 'SessionStart') response.additionalContext = notMemberText(cliPath(), r.joinError)
      if (pending) response.sessionTitle = pending
      return Object.keys(response).length ? (response as SubscriberResponse) : undefined
    }

    if (event === 'UserPromptSubmit') recordPrompt(ctx.dataDir, r.member)
    const done = await completeHeld(ctx.dataDir, local, comms, r.member, metaFor(p, env)).catch(() => undefined)
    if (done) r.member = local.sessionMember(p.session_id) ?? r.member
    // A held rename: the title is already the new name and the member keeps the old one until its
    // claims are released, so comms must not set the title back.
    const held = heldRenames(ctx.dataDir)[r.member]
    if (r.setTitle && held && held.to === p.session_title?.trim()) r.setTitle = undefined
    await comms.beat(r.member).catch(() => undefined)
    const items = await comms.inbox(r.member)
    comms.markSeen(r.member, items.slice(0, 10).map((i) => i.id))

    const lines: string[] = done ? [done] : []
    const verbose = isVerbose(ctx.dataDir, env)
    if (event === 'SessionStart') {
      const { reg } = await comms.state()
      const roles = [...(reg.members.get(r.member)?.roles ?? [])].sort()
      lines.push(
        verbose
          ? `Cortex comms: this session is member ${r.member} in role${roles.length === 1 ? '' : 's'} ${roles.join(', ') || '(none)'}.` +
              (r.note ? ` (${r.note})` : '') +
              ` Address others as role or role/member; see ${cliPath()} whoami.`
          : `Cortex comms: you are ${r.member} (${roles.join(', ') || 'no role'}).`,
      )
    } else if (r.note) {
      lines.push(`Cortex comms: ${r.note}; this session is ${r.member}.`)
    }
    if (items.length) lines.push(deliveryText(r.member, items, cliPath(), verbose))
    const note = event === 'UserPromptSubmit' && p.session_id ? takeReminderNote(ctx.dataDir, p.session_id) : undefined
    if (note) lines.push(note)

    const watch = watchStatus(ctx.dataDir, r.member)
    if (event === 'SessionStart' && watch.kind !== 'live') {
      // Telling the session at start counts as its reminder, so the first
      // prompt does not repeat it; only a later lapse is mentioned again.
      takeReminder(ctx.dataDir, r.member, p.session_id, watch)
      const how = watch.kind === 'lapsed' ? `Cortex comms: ${lapseText(ctx.dataDir, r.member, watch)}. ` : ''
      lines.push(how + watchInstruction(cliPath()))
    } else if (event === 'UserPromptSubmit' && takeReminder(ctx.dataDir, r.member, p.session_id, watch)) {
      lines.push(
        watch.kind === 'lapsed'
          ? `Cortex comms: ${lapseText(ctx.dataDir, r.member, watch)}, so messages arrive only at prompts. ${watchInstruction(cliPath())}`
          : `Cortex comms: no watcher is running, so messages arrive only at prompts. ${watchInstruction(cliPath())}`,
      )
    }

    const response: Record<string, string> = {}
    if (lines.length) response.additionalContext = lines.join('\n\n')
    if (r.setTitle) response.sessionTitle = r.setTitle
    return Object.keys(response).length ? (response as SubscriberResponse) : undefined
  } catch (err) {
    ctx.log(`comms unavailable (${err instanceof Error ? err.message : String(err)}); session continues without it`)
    return undefined
  }
}

/**
 * Stop: a comms member may not end a turn deaf after being told (19 Oct 2026:
 * "pause means no new work, never unreachable"). An instruction to re-arm was
 * not enough: a session woken by the watcher's own expiry notice decided to
 * leave it off. So the turn is held open with the re-arm instruction, at most
 * STOP_BLOCKS_PER_LAPSE times per lapse, so a session that cannot run Monitor
 * is never looped.
 *
 * Claude Code shows every hold as a hook error, so it is kept to the cases
 * stopShouldHold names. A watcher that lapses during the turn is not held for:
 * its Monitor-ended notice wakes the session and the prompt reminder tells it.
 * A recent `cortex-role standdown` means the stop was chosen: nothing is held
 * or noted.
 *
 * A Monitor started late in the turn may not have written its state yet, so a
 * watcher that is not live is given a short grace before the verdict.
 */
export const handleStop = async (
  payload: unknown,
  ctx: ModuleCtx,
  open: (dataDir: string) => { local: LocalIdentity; comms?: Comms } = openComms,
  env: NodeJS.ProcessEnv = process.env,
  // Under the dispatcher's per-module budget (1750 ms), or the hold is cut off and the turn ends anyway.
  graceMs = 1_000,
): Promise<SubscriberResponse> => {
  const p = (payload ?? {}) as HookPayload
  if (p.agent_id || isHeadless(env)) return undefined
  try {
    const { local, comms } = open(ctx.dataDir)
    const title = p.session_title?.trim()
    const member = title && local.member(title) ? title : local.sessionMember(p.session_id)
    if (!member || !local.member(member)) return undefined
    const sd = standDown(ctx.dataDir, member)
    if (sd && Date.now() - sd.at < STAND_DOWN_MS) return undefined

    const promptAt = lastPromptAt(ctx.dataDir, member)
    let watch: WatchStatus = watchStatus(ctx.dataDir, member)
    if (stopShouldHold(watch, promptAt)) {
      for (const until = Date.now() + graceMs; watch.kind !== 'live' && Date.now() < until; ) {
        await new Promise((r) => setTimeout(r, 250))
        watch = watchStatus(ctx.dataDir, member)
      }
    }
    if (!stopShouldHold(watch, promptAt) || !takeStopBlock(ctx.dataDir, member, p.session_id, watch)) {
      if (comms && p.session_id) await noteAwaits(ctx.dataDir, p.session_id, local, comms, member)
      return undefined
    }
    const since = watch.kind === 'lapsed' ? ` since ${new Date(watch.at).toISOString().slice(11, 16)}Z` : ''
    return {
      decision: 'deny',
      reason:
        'Cortex reminder (not an error): re-arm your watcher. ' +
        `${member} has no live watcher${since}, so messages to it wait unseen. ` +
        `Re-arm it now, before ending the turn; a pause means no new work, never unreachable. ${watchInstruction(cliPath())}`,
    }
  } catch (err) {
    ctx.log(`comms stop check skipped (${err instanceof Error ? err.message : String(err)})`)
    return undefined
  }
}

/**
 * Once per key: a message this member has seen says someone expects an answer
 * elsewhere, and no answer is marked. The next prompt carries the how, not a
 * held Stop (Claude Code shows a hold as a hook error); after that it is the
 * member's call.
 */
const noteAwaits = async (dataDir: string, session: string, local: LocalIdentity, comms: Comms, member: string) => {
  const done = local.awaits(member)
  const seen = local.seen(member)
  const owed = (await comms.inbox(member, { includeSeen: true })).filter((i) => i.awaits && seen.has(i.id) && !done[i.awaits.key])
  for (const i of owed) {
    local.markAwait(member, i.awaits!.key, 'reminded')
    addReminder(dataDir, session, `awaits:${i.awaits!.key}`, `Cortex comms: an answer is still expected for a message from ${i.from} (reminded once, not again): ${i.awaits!.how}`)
  }
}

/** One line: how to listen live. Monitor caps a watch at 30 minutes, so it is re-armed. */
export const watchInstruction = (cli: string): string =>
  `To receive messages as they arrive, start a Monitor with command "${cli} watch" and timeout_ms 1800000; when it prints "watch window ended", start it again.`
