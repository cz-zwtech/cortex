import type { ParsedMessage } from '@/adapters'

/**
 * In-memory LRU cache of parsed conversations.
 *
 * Conversations get appended to by live Claude Code sessions, so we also
 * track in-flight parses (`pending`) to dedupe concurrent requests for the
 * same path — e.g. a prefetch started on hover followed by an actual click
 * shouldn't parse twice.
 *
 * Invalidated on fs:change events by the app store.
 */

const MAX = 50

const cache = new Map<string, ParsedMessage[]>()
const pending = new Map<string, Promise<ParsedMessage[]>>()

export const getCachedConversation = (path: string): ParsedMessage[] | undefined => {
  const v = cache.get(path)
  if (v) {
    cache.delete(path)
    cache.set(path, v) // LRU bump
  }
  return v
}

export const setCachedConversation = (path: string, messages: ParsedMessage[]): void => {
  if (cache.has(path)) {
    cache.delete(path)
  } else if (cache.size >= MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(path, messages)
}

export const getPendingConversation = (path: string): Promise<ParsedMessage[]> | undefined =>
  pending.get(path)

export const setPendingConversation = (path: string, p: Promise<ParsedMessage[]>): void => {
  pending.set(path, p)
}

export const clearPendingConversation = (path: string): void => {
  pending.delete(path)
}

export const invalidateConversation = (path: string): void => {
  cache.delete(path)
  pending.delete(path)
}

export const invalidateAllConversations = (): void => {
  cache.clear()
  pending.clear()
}
