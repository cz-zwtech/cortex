import {
  createPersistentCache,
  invalidatePath,
  type FileStamp,
} from './persistentCache'

/**
 * Shared per-path cache for parsed Entity values from the markdown-backed
 * adapters (agent, command, skill, rule, memory, claudemd). Entity fields
 * are stable for a given (path, stamp), so one disk-persisted namespace
 * serves all of them.
 */

export type { FileStamp } from './persistentCache'

const cache = createPersistentCache<unknown>('file-cache')

export const getCachedFile = <T>(path: string, stamp: FileStamp): T | null =>
  cache.get(path, stamp) as T | null

export const setCachedFile = <T>(
  path: string,
  stamp: FileStamp,
  value: T,
): void => {
  cache.set(path, stamp, value)
}

export const invalidateFile = (path: string): void => {
  invalidatePath(path)
}
