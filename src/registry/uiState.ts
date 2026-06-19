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
  /**
   * #128: baked graph-view layout — node positions persisted per-machine so the force
   * graph opens FROZEN instead of re-radiating. `sig` is an edge-aware signature; a
   * mismatch triggers a silent re-settle. x3/y3/z3 are reserved for the future 3D
   * renderer and not written by the 2D bake.
   */
  graphLayout?: {
    sig: string
    nodes: { id: string; x: number; y: number; x3?: number; y3?: number; z3?: number }[]
  }
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
    graphLayout: loaded?.graphLayout,
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
