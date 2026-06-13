/**
 * Directory picker — replaces the Tauri native dialog.
 * Prompts the user to type a path in a lightweight modal.
 * The modal is rendered by <DirectoryPickerModal> mounted in App.tsx.
 */

type Resolver = (path: string | null) => void

let pending: Resolver | null = null
const listeners = new Set<() => void>()

export const _dialogBus = {
  /** Called by the modal to notify it should open */
  onOpen: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
  /** Called by the modal when user confirms or cancels */
  resolve: (path: string | null) => { pending?.(path); pending = null },
  hasPending: () => pending !== null,
}

export const pickDirectory = (): Promise<string | null> => {
  return new Promise((resolve) => {
    pending = resolve
    listeners.forEach((fn) => fn())
  })
}
