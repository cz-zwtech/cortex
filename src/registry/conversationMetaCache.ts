import {
  createPersistentCache,
  type FileStamp,
} from './persistentCache'

/**
 * Persisted cache of the expensive-to-compute conversation metadata
 * (`title`, times, counts). Stored independently of the scope-sensitive
 * Entity wrapper so the same file is usable from both user and project
 * views without cross-pollinating scope/id fields.
 */

export interface ConversationMeta {
  title: string
  startTime: string
  lastTime: string
  turnCount: number
  tokenCount: number
}

const cache = createPersistentCache<ConversationMeta>('conversation-meta')

export const getConversationMeta = (
  path: string,
  stamp: FileStamp,
): ConversationMeta | null => cache.get(path, stamp)

export const setConversationMeta = (
  path: string,
  stamp: FileStamp,
  meta: ConversationMeta,
): void => {
  cache.set(path, stamp, meta)
}

export const invalidateConversationMeta = (path: string): void => {
  cache.invalidate(path)
}
