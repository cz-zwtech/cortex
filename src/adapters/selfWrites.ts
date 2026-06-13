/**
 * Tracks paths the app has just mutated so the file-system watcher can ignore
 * the echoes of our own writes. Without this, every save triggers a watcher
 * event that triggers a reload that re-renders the world.
 *
 * Entries expire after `windowMs` to avoid suppressing a genuinely external
 * change that happens to hit the same path moments later.
 */

const windowMs = 2000
const recent = new Map<string, number>()

const norm = (p: string): string =>
  p.replace(/\\/g, '/').replace(/\/+$/, '')

export const recordSelfWrite = (path: string): void => {
  if (!path) return
  recent.set(norm(path), Date.now() + windowMs)
}

export const isRecentSelfWrite = (path: string): boolean => {
  const key = norm(path)
  const exp = recent.get(key)
  if (exp === undefined) return false
  if (Date.now() > exp) {
    recent.delete(key)
    return false
  }
  return true
}
