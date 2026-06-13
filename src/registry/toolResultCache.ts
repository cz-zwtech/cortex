/**
 * Per-file lazy cache of tool_result blocks.
 *
 * Tool results (Read contents, Bash stdout, Agent output, ...) can make up the
 * bulk of a conversation's bytes. Most are never looked at. We skip them
 * during the main message parse and load them here on first access — either
 * when the modal opens or when an inline preview wants to display output.
 *
 * One map per file path, stored as a Promise so concurrent callers dedupe.
 * LRU-capped at a small number of recently-viewed files.
 */

const MAX = 10

const results = new Map<string, Map<string, string>>()
const pending = new Map<string, Promise<Map<string, string>>>()

export const getCachedToolResults = (path: string): Map<string, string> | undefined => {
  const v = results.get(path)
  if (v) {
    results.delete(path)
    results.set(path, v) // LRU bump
  }
  return v
}

export const setCachedToolResults = (path: string, map: Map<string, string>): void => {
  if (results.has(path)) {
    results.delete(path)
  } else if (results.size >= MAX) {
    const oldest = results.keys().next().value
    if (oldest !== undefined) results.delete(oldest)
  }
  results.set(path, map)
}

export const getPendingToolResults = (path: string): Promise<Map<string, string>> | undefined =>
  pending.get(path)

export const setPendingToolResults = (path: string, p: Promise<Map<string, string>>): void => {
  pending.set(path, p)
}

export const clearPendingToolResults = (path: string): void => {
  pending.delete(path)
}

export const invalidateToolResults = (path: string): void => {
  results.delete(path)
  pending.delete(path)
}

export const invalidateAllToolResults = (): void => {
  results.clear()
  pending.clear()
}
