/**
 * The event bus — a core amenity.
 *
 * The brief: "a simple message bus/queue that exists with no overhead, but
 * available if something wants to use it."
 *
 * Deliberately built once for two uses (internal decoupling AND public mod
 * surface). Building it internal-first and widening it later would be a
 * breaking change to the contract, so it gets public semantics from the start.
 *
 * "No overhead when unused" is literal: no timers, no queues allocated, no
 * background work. An event with no subscribers is a Map lookup that misses.
 *
 * Delivery is sequential and awaited, not fire-and-forget. Ordering between
 * subscribers must be deterministic (core-controlled coordination, not
 * incidental), and a publisher that needs to know everyone has run must be able
 * to await it. A throwing subscriber is isolated and reported — one bad mod
 * cannot take down an event for the others.
 */

export type EventHandler = (payload: unknown) => unknown | Promise<unknown>

type Entry = {
  module: string
  order: number
  handler: EventHandler
  seq: number
}

export type DeliveryFailure = { module: string; error: Error; timedOut?: boolean }

/**
 * A subscriber that exceeded its budget but could NOT be stopped — it blocked
 * the event loop. Reported rather than prevented; see PublishOptions.
 */
export type Overrun = { module: string; elapsedMs: number; budgetMs: number }

export type DeliveryResult = {
  delivered: number
  failures: DeliveryFailure[]
  /** Budget exceeded but completed anyway. Observation, not enforcement. */
  overruns: Overrun[]
  /**
   * Each successful subscriber's return value, PAIRED WITH ITS MODULE.
   *
   * Not a bare array: a failing subscriber contributes no result, so positional
   * alignment against the subscriber list silently shifts and attributes every
   * later result to the wrong module. That misattribution is invisible — the
   * values are all real, just labelled wrong — which is the worst kind.
   */
  results: { module: string; value: unknown }[]
}

export type PublishOptions = {
  /**
   * Per-subscriber time box, ms.
   *
   * ⚠ THIS IS OBSERVE-NOT-ENFORCE, and the distinction is load-bearing.
   *
   * In-process JavaScript has no preemption. A subscriber that yields (awaits
   * I/O, timers, network) IS abandoned at the deadline and the remaining
   * subscribers run. A subscriber that blocks the event loop — a synchronous
   * native call such as better-sqlite3, which is precisely what a memory module
   * does — CANNOT be interrupted. The timer cannot fire while the loop is
   * blocked, so it runs to completion regardless of this value.
   *
   * Measured, not assumed: an 800ms synchronous busy-loop against a 50ms budget
   * completed in full, and an earlier revision of this file did not even
   * REPORT it, because the rejection raced a timer that never got scheduled.
   * Overruns are now always measured after the fact (`overran`), so a blocking
   * subscriber is at least visible even when it cannot be stopped.
   *
   * CONSEQUENCE FOR THE ARCHITECTURE, stated honestly. There are THREE levels
   * of isolation, not two — an earlier revision of this comment said
   * coordination gives up OS-level isolation entirely, which overstated it:
   *
   *   fan-out            per-MODULE OS isolation. The harness kills one
   *                      module's process; the others are untouched.
   *   this dispatcher    per-EVENT OS isolation. The harness kills the whole
   *                      event's process. Real, but coarser.
   *   in-process         per-SUBSCRIBER isolation — does not exist at any
   *                      level without worker threads.
   *
   * So coordination costs per-module isolation, not all isolation, and buys
   * deterministic ordering, one process per event, and a settings file that
   * module installs never touch.
   *
   * The failure that makes worker threads worth it later is not the per-session
   * stall — it is that a WARM shared server serves every session on the machine.
   * A subscriber blocking that event loop queues every other session's hooks,
   * the UI and the bus behind it. In-process dispatch on a shared daemon
   * serialises the whole machine. The short-lived dispatcher process this file
   * currently runs under does not have that problem, which is why the warm path
   * is the dangerous one to add, not the safe one.
   */
  perSubscriberMs?: number
  /**
   * Total budget across all subscribers, ms. Once exhausted, remaining
   * subscribers are skipped and reported rather than silently dropped.
   */
  totalMs?: number
}

class TimeoutError extends Error {
  override name = 'TimeoutError'
}

/**
 * Race a handler against its budget.
 *
 * Note the abandoned promise keeps running — JS has no way to cancel it. That
 * is acceptable here because the dispatcher is a short-lived per-event process
 * that exits shortly after; a long-lived host would need real cancellation.
 * Saying so explicitly because "it timed out" reads as "it stopped", and it
 * did not.
 */
const withTimeout = <T,>(p: Promise<T>, ms: number, module: string): Promise<T> => {
  let timer: NodeJS.Timeout
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutError(`${module} exceeded its ${ms}ms budget`)),
        ms,
      )
      timer.unref?.()
    }),
  ])
}

export class EventBus {
  #subs = new Map<string, Entry[]>()
  #seq = 0

  /**
   * Subscribe. Lower `order` runs earlier; ties break by subscription order so
   * the sequence is stable rather than depending on Map iteration.
   * Returns an unsubscribe function — used when a mod stops.
   */
  subscribe(topic: string, module: string, handler: EventHandler, order = 100): () => void {
    const entry: Entry = { module, order, handler, seq: this.#seq++ }
    const list = this.#subs.get(topic)
    if (list) list.push(entry)
    else this.#subs.set(topic, [entry])

    this.#subs.get(topic)!.sort((a, b) => a.order - b.order || a.seq - b.seq)

    return () => {
      const current = this.#subs.get(topic)
      if (!current) return
      const i = current.indexOf(entry)
      if (i >= 0) current.splice(i, 1)
      if (current.length === 0) this.#subs.delete(topic)
    }
  }

  /** Drop every subscription belonging to a module. Called on module stop. */
  unsubscribeModule(module: string): void {
    for (const [topic, list] of this.#subs) {
      const kept = list.filter((e) => e.module !== module)
      if (kept.length === 0) this.#subs.delete(topic)
      else this.#subs.set(topic, kept)
    }
  }

  /**
   * Publish, awaiting each subscriber in order.
   *
   * A subscriber that throws does NOT abort delivery: the failure is captured
   * against the module that caused it and the remaining subscribers still run.
   * Isolating faults is the whole point of core owning coordination.
   */
  async publish(
    topic: string,
    payload?: unknown,
    opts: PublishOptions = {},
  ): Promise<DeliveryResult> {
    const list = this.#subs.get(topic)
    if (!list || list.length === 0)
      return { delivered: 0, failures: [], overruns: [], results: [] }

    const failures: DeliveryFailure[] = []
    const overruns: Overrun[] = []
    const results: { module: string; value: unknown }[] = []
    const startedAt = Date.now()

    for (const entry of [...list]) {
      if (opts.totalMs !== undefined && Date.now() - startedAt >= opts.totalMs) {
        // Skipped, not silently dropped — a subscriber that never ran because
        // the budget was spent is something the user needs to be able to see.
        failures.push({
          module: entry.module,
          error: new Error('skipped: total event budget exhausted'),
          timedOut: true,
        })
        continue
      }

      const calledAt = Date.now()
      try {
        const call = Promise.resolve(entry.handler(payload))
        results.push({
          module: entry.module,
          value:
            opts.perSubscriberMs === undefined
              ? await call
              : await withTimeout(call, opts.perSubscriberMs, entry.module),
        })

        // Always measure. A subscriber that blocked the loop cannot be
        // abandoned, so the ONLY way it becomes visible is after the fact —
        // and invisible overruns are how one module silently eats an event's
        // whole allowance while everything looks green.
        const elapsed = Date.now() - calledAt
        if (opts.perSubscriberMs !== undefined && elapsed > opts.perSubscriberMs) {
          overruns.push({ module: entry.module, elapsedMs: elapsed, budgetMs: opts.perSubscriberMs })
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        failures.push({ module: entry.module, error, timedOut: error.name === 'TimeoutError' })
      }
    }

    return { delivered: list.length - failures.length, failures, overruns, results }
  }

  /** Subscriber count for a topic — used by `status`, and by tests. */
  count(topic: string): number {
    return this.#subs.get(topic)?.length ?? 0
  }

  /** Topics with at least one subscriber. */
  topics(): string[] {
    return [...this.#subs.keys()].sort()
  }
}
