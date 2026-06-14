/**
 * Silent-layer trigger (#111). Fires the per-turn LOCAL md→graph fold and AWAITS only the
 * fast ack — the server enqueues the fold and acks immediately, the heavy fold runs async
 * there (so the prompt is never blocked), and awaiting the ack guarantees DELIVERY (a
 * spawn-and-exit from this short-lived hook could die before the request flushed).
 *
 * A down/busy server is swallowed: this must NEVER block or break the prompt. It is LOCAL
 * ONLY — it posts to /api/graph/sync/turn and never touches the remote/mind-sync path.
 */
export const TURN_SYNC_PATH = '/api/graph/sync/turn'

type FetchLike = (url: string, init?: unknown) => Promise<{ ok: boolean; status: number }>

export async function triggerTurnSyncRequest(
  serverUrl: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 1000,
): Promise<'delivered' | 'failed'> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${serverUrl}${TURN_SYNC_PATH}`, { method: 'POST', signal: ctrl.signal })
    return res && res.ok ? 'delivered' : 'failed'
  } catch {
    return 'failed' // server down/busy/aborted → swallow; the prompt is never blocked or broken
  } finally {
    clearTimeout(timer)
  }
}
