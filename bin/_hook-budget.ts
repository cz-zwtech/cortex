/**
 * Time-budget helpers for the prompt-boundary hook (ckn-pause-context).
 *
 * The UserPromptSubmit hook must deliver presence + inbox within a small budget or
 * Claude Code discards its WHOLE stdout — a SILENT inbox drop. On a cold resume the
 * risk is (a) the un-timed touch/delivered fetches stalling on a slow/cold server
 * and (b) the synchronous /proc watcher scan running on the critical path after the
 * bus work. These helpers bound both so the hook stays under budget and always gets
 * its inbox out (undelivered messages re-fetch next prompt — deferral, never loss).
 */

/** Soft wall-clock budget for the hook's critical work. Once the critical block has
 *  consumed this, the deferrable /proc watcher scan is skipped for the prompt (the
 *  nag re-appears next prompt / the statusline still shows it) so a slow resume
 *  never pushes the whole hook past the registrar-raised timeout. */
export const HOOK_SOFT_BUDGET_MS = 2000

/** True while there is still budget to run the deferrable /proc watcher scan. */
export const watcherScanFitsBudget = (
  elapsedMs: number,
  budgetMs: number = HOOK_SOFT_BUDGET_MS,
): boolean => elapsedMs < budgetMs

/** fetch bounded by an AbortController deadline. Resolves to the Response, or null
 *  on timeout/error — a hung or slow server can never stall the hook past `ms`. */
export const fetchBounded = async (
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response | null> => {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}
