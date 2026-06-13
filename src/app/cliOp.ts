import { toast } from 'sonner'
import { useStore } from './store'

interface CliOpInput<T> {
  /** Stable key for `pendingOps`, e.g. `install:open-prose@prose`. */
  key: string
  /** Toast text shown while the operation is in flight. */
  loading: string
  /** Toast text shown on success. */
  success: string
  /** The CLI/async work itself. */
  action: () => Promise<T>
  /** Override the displayed error message. Defaults to the thrown error's message. */
  formatError?: (e: unknown) => string
  /** If true (default), trigger a `store.reload()` between completion and success toast. */
  reload?: boolean
}

/**
 * Wrap a CLI action with consistent UX:
 *   - Mark a pending key in the store so any UI can show a spinner / disable a button.
 *   - Show a loading toast for the duration.
 *   - Force a store reload so list/editor reflect on-disk changes immediately.
 *   - Dismiss the loading toast and show success/error with the design-system icon colors.
 *
 * All async actions (install, uninstall, refresh marketplace, etc.) should go through
 * this helper rather than rolling their own toast + reload + spinner state.
 */
export const runCliOp = async <T>(input: CliOpInput<T>): Promise<T> => {
  const { key, loading, success, action, formatError, reload = true } = input
  return useStore.getState().runOp(key, async () => {
    const t = toast.loading(loading, { duration: 600_000 })
    try {
      const result = await action()
      if (reload) await useStore.getState().reload()
      toast.dismiss(t)
      toast.success(success)
      return result
    } catch (e) {
      toast.dismiss(t)
      const msg = formatError ? formatError(e) : e instanceof Error ? e.message : String(e)
      toast.error(msg)
      throw e
    }
  })
}

/** Reactive: returns true while an op with the given key is pending. */
export const useIsOpPending = (key: string): boolean =>
  useStore((s) => s.pendingOps.has(key))
