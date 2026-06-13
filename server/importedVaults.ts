/**
 * Persistent record of vault imports — rebuildable graph property.
 *
 * Without this, deleting graph.db loses every vault-imported entry
 * because `syncMemories` only walks ~/.claude/memory/. Vault content
 * lives in the user's Obsidian vault and is brought in via
 * `importVaultPaths()`.
 *
 * After a successful import, the import route records the (vaultName,
 * paths) pair here. On every sync, syncMemories reads this list and
 * re-runs `importVaultPaths` for each entry. The graph DB stays a
 * derived index — delete it, run sync, recover everything including
 * vault-sourced memories.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const STATE_PATH = path.join(os.homedir(), '.config', 'ckn', 'imported-vaults.json')

export interface ImportedVault {
  vaultName: string
  paths: string[]
  /** Last-import timestamp; updated by recordImport. */
  lastImportedAt: number
}

interface State {
  version: 1
  vaults: ImportedVault[]
}

const readState = async (): Promise<State> => {
  try {
    const raw = await fsp.readFile(STATE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<State>
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.vaults)) {
      return { version: 1, vaults: [] }
    }
    return parsed as State
  } catch {
    return { version: 1, vaults: [] }
  }
}

const writeState = async (state: State): Promise<void> => {
  await fsp.mkdir(path.dirname(STATE_PATH), { recursive: true })
  await fsp.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * Record (or update) an import. If the vaultName already exists, the
 * paths list is replaced (so the user's "current" import for that
 * vault is what we re-run). lastImportedAt always bumps.
 */
export const recordImport = async (vaultName: string, paths: string[]): Promise<void> => {
  const state = await readState()
  const idx = state.vaults.findIndex((v) => v.vaultName === vaultName)
  if (idx >= 0) {
    state.vaults[idx] = { vaultName, paths, lastImportedAt: Date.now() }
  } else {
    state.vaults.push({ vaultName, paths, lastImportedAt: Date.now() })
  }
  await writeState(state)
}

/** Drop a recorded vault. Used by the import dialog's "remove" action. */
export const removeImport = async (vaultName: string): Promise<void> => {
  const state = await readState()
  state.vaults = state.vaults.filter((v) => v.vaultName !== vaultName)
  await writeState(state)
}

export const listImports = async (): Promise<ImportedVault[]> => {
  const state = await readState()
  return [...state.vaults]
}
