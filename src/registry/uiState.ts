import { fs, join, readJsonOrNull } from '@/adapters'
import type { Scope } from '@/ontology'

export interface UiState {
  selections: Record<string, string>
  lastScopeKey?: string
  lastKind?: string
  /** Tags per project, keyed by projectId. Stored here so we never touch ~/.claude.json */
  projectTags?: Record<string, string[]>
  /** Tags currently hidden from the sidebar. Persisted so it survives restarts. */
  hiddenTags?: string[]
  /**
   * Tags applied directly to non-project graph scopes (e.g. `vault:sokn`,
   * `user`). Keyed by the raw scope string as it appears on a graph entry.
   * Lets the global tag-hide system extend to vaults and the user scope.
   */
  scopeTags?: Record<string, string[]>
  /**
   * Sessions hidden from the picker + tab strip. Keyed by `projectDir/id`.
   * Files are never deleted — this is a UI filter only.
   */
  hiddenSessionIds?: string[]
}

const uiStatePath = (home: string): string =>
  join(home, '.config', 'ckn', 'ui-state.json')

export const loadUiState = async (home: string): Promise<UiState> => {
  const loaded = await readJsonOrNull<UiState>(uiStatePath(home))
  return {
    selections: loaded?.selections ?? {},
    lastScopeKey: loaded?.lastScopeKey,
    lastKind: loaded?.lastKind,
    projectTags: loaded?.projectTags ?? {},
    hiddenTags: loaded?.hiddenTags ?? [],
    scopeTags: loaded?.scopeTags ?? {},
    hiddenSessionIds: loaded?.hiddenSessionIds ?? [],
  }
}

export const saveUiState = async (home: string, state: UiState): Promise<void> => {
  await fs.writeJson(uiStatePath(home), state)
}

export const scopeFromKey = (key: string): Scope | null => {
  if (key === 'user') return { type: 'user' }
  if (key.startsWith('project:'))
    return { type: 'project', projectId: key.slice('project:'.length) }
  return null
}
