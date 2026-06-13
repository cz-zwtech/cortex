import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { graphImportVault, graphListScopes, graphDeleteScope } from '@/adapters/graph'
import { pickDirectory } from '@/adapters/dialog'
import { useStore } from '@/app/store'

interface DiscoveredVault {
  id: string | null
  name: string
  path: string
}

interface ImportingState {
  vaultName: string
  status: 'discovering' | 'scanning' | 'importing' | 'done' | 'error'
  message: string
  imported: number
  errors: string[]
}

interface DialogStore {
  open: boolean
  discovered: DiscoveredVault[]
  detected: boolean
  scopes: { scope: string; count: number }[]
  manualPath: string
  manualName: string
  importing: ImportingState | null
  beginOpen: () => Promise<void>
  setManualPath: (path: string) => void
  setManualName: (name: string) => void
  reloadScopes: () => Promise<void>
  importPath: (vaultName: string, vaultPath: string) => Promise<void>
  deleteScope: (scope: string) => Promise<void>
  close: () => void
}

const useDialog = create<DialogStore>((set, get) => ({
  open: false,
  discovered: [],
  detected: false,
  scopes: [],
  manualPath: '',
  manualName: '',
  importing: null,
  beginOpen: async () => {
    set({ open: true, importing: null, manualPath: '', manualName: '' })
    // Probe in parallel
    try {
      const [vaultsRes, scopes] = await Promise.all([
        fetch('/api/obsidian/vaults').then((r) => r.json()),
        graphListScopes(),
      ])
      set({
        discovered: vaultsRes.vaults ?? [],
        detected: !!vaultsRes.detected,
        scopes,
      })
    } catch {
      set({ discovered: [], detected: false, scopes: [] })
    }
  },
  setManualPath: (path) => {
    const trimmed = path.trim()
    const fallbackName = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? ''
    set((s) => ({
      manualPath: path,
      manualName: s.manualName || fallbackName,
    }))
  },
  setManualName: (name) => set({ manualName: name }),
  reloadScopes: async () => {
    try {
      const scopes = await graphListScopes()
      set({ scopes })
    } catch {}
  },
  importPath: async (vaultName, vaultPath) => {
    set({
      importing: {
        vaultName,
        status: 'scanning',
        message: `Scanning ${vaultPath}…`,
        imported: 0,
        errors: [],
      },
    })
    try {
      const targets: string[] = [
        `${vaultPath}/claude-memory/compiled`,
        `${vaultPath}/philosophy`,
        vaultPath,
      ]
      set((s) => ({
        importing: {
          ...s.importing!,
          status: 'importing',
          message: `Reading markdown under ${vaultPath}…`,
        },
      }))
      const result = await graphImportVault(vaultName, targets)
      set((s) => ({
        importing: {
          ...s.importing!,
          status: 'done',
          message:
            result.imported === 0
              ? `No markdown found in ${vaultPath}.`
              : `Imported ${result.imported} entries from ${vaultName}.`,
          imported: result.imported,
          errors: result.errors,
        },
      }))
      // Refresh scope counts AND knowledge results so newly imported entries
      // appear in the Context sidebar without a manual reload.
      await Promise.all([
        get().reloadScopes(),
        useStore.getState().refreshGraph(),
      ])
    } catch (e: any) {
      set((s) => ({
        importing: {
          ...s.importing!,
          status: 'error',
          message: e?.message ?? 'Import failed',
        },
      }))
    }
  },
  deleteScope: async (scope) => {
    try {
      await graphDeleteScope(scope)
      await Promise.all([
        get().reloadScopes(),
        useStore.getState().refreshGraph(),
      ])
    } catch {}
  },
  close: () => set({ open: false, importing: null }),
}))

export const openVaultImportDialog = (): Promise<void> => useDialog.getState().beginOpen()

// ── Host component ───────────────────────────────────────────────────────────

export function VaultImportDialogHost() {
  const {
    open,
    discovered,
    detected,
    scopes,
    manualPath,
    manualName,
    importing,
    setManualPath,
    setManualName,
    importPath,
    deleteScope,
    close,
  } = useDialog()

  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)

  useEffect(() => {
    if (!open) setConfirmingDelete(null)
  }, [open])

  if (!open) return null

  const handleManualBrowse = async () => {
    const picked = await pickDirectory()
    if (picked) setManualPath(picked)
  }

  const handleManualImport = async () => {
    if (!manualPath || !manualName) return
    await importPath(manualName, manualPath)
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(7,8,26,0.85)', backdropFilter: 'blur(2px)' }}
      onClick={close}
    >
      <div
        className="w-[640px] max-h-[80vh] flex flex-col"
        style={{
          background: 'var(--color-bg-1)',
          border: '1px solid var(--color-line)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 24px rgba(176,112,255,0.15)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--color-line)]"
          style={{ background: 'linear-gradient(180deg, #14172e, transparent)' }}
        >
          <span className="vt t-amber t-glow-amber tracking-[0.18em] text-[14px]">◈ IMPORT</span>
          <span className="t-ghost">│</span>
          <span className="t-dim text-[11px] flex-1">Bring markdown into the knowledge graph</span>
          <button onClick={close} className="btn t-ghost text-[14px] leading-none px-2" aria-label="Close">×</button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-auto">
          {/* Discovered vaults */}
          <section className="px-4 py-3 border-b border-[var(--color-line)]">
            <div className="t-ghost text-[10px] tracking-[0.25em] mb-2">// DISCOVERED</div>
            {!detected && (
              <div className="t-dim text-[11px] italic mb-1.5">
                No Obsidian config files found (checked Linux + WSL Windows AppData).
              </div>
            )}
            {detected && discovered.length === 0 && (
              <div className="t-dim text-[11px] italic mb-1.5">
                Obsidian found, but no vaults configured.
              </div>
            )}
            {discovered.map((v) => (
              <div
                key={v.path}
                className="flex items-center gap-2 py-1.5 border-t border-[var(--color-line)] first:border-t-0"
              >
                <div className="flex-1 min-w-0">
                  <div className="t-mid text-[12px]">◇ {v.name}</div>
                  <div className="t-ghost text-[10px] truncate" title={v.path}>{v.path}</div>
                </div>
                <button
                  onClick={() => importPath(v.name, v.path)}
                  className="btn text-[11px]"
                  disabled={importing?.status === 'scanning' || importing?.status === 'importing'}
                >
                  import →
                </button>
              </div>
            ))}
          </section>

          {/* Manual entry */}
          <section className="px-4 py-3 border-b border-[var(--color-line)]">
            <div className="t-ghost text-[10px] tracking-[0.25em] mb-2">// MANUAL</div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="t-ghost text-[10px] w-12">name</span>
                <input
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder="vault name (lowercase recommended)"
                  className="flex-1 bg-transparent outline-none px-2 py-1 text-[11px] t-mid placeholder:text-[color:var(--color-ghost)]"
                  style={{ border: '1px solid var(--color-line)' }}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="t-ghost text-[10px] w-12">path</span>
                <input
                  value={manualPath}
                  onChange={(e) => setManualPath(e.target.value)}
                  placeholder="/absolute/path/to/vault"
                  className="flex-1 bg-transparent outline-none px-2 py-1 text-[11px] t-mid placeholder:text-[color:var(--color-ghost)] font-mono"
                  style={{ border: '1px solid var(--color-line)' }}
                />
                <button onClick={handleManualBrowse} className="btn text-[11px]" title="Pick a directory">
                  browse…
                </button>
              </div>
              <div className="flex justify-end mt-1">
                <button
                  onClick={handleManualImport}
                  disabled={
                    !manualPath ||
                    !manualName ||
                    importing?.status === 'scanning' ||
                    importing?.status === 'importing'
                  }
                  className="btn text-[11px] disabled:opacity-40"
                >
                  import →
                </button>
              </div>
            </div>
          </section>

          {/* Existing scopes in graph */}
          {scopes.length > 0 && (
            <section className="px-4 py-3 border-b border-[var(--color-line)]">
              <div className="t-ghost text-[10px] tracking-[0.25em] mb-2">// IN GRAPH</div>
              <div className="t-dim text-[10px] mb-1.5">
                Re-importing the same vault name updates entries in place. Delete a scope to purge it.
              </div>
              {scopes.map((s) => (
                <div
                  key={s.scope}
                  className="flex items-center gap-2 py-1 border-t border-[var(--color-line)] first:border-t-0"
                >
                  <span className="t-mid text-[11px] flex-1 truncate font-mono">{s.scope}</span>
                  <span className="t-ghost text-[10px]">· {s.count}</span>
                  {confirmingDelete === s.scope ? (
                    <>
                      <span className="t-warn text-[10px]">delete?</span>
                      <button
                        onClick={() => {
                          void deleteScope(s.scope)
                          setConfirmingDelete(null)
                        }}
                        className="btn text-[10px] !text-[color:var(--color-rose)] !border-[color:var(--color-rose-dim)]"
                      >
                        yes
                      </button>
                      <button onClick={() => setConfirmingDelete(null)} className="btn text-[10px]">
                        no
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmingDelete(s.scope)}
                      className="btn text-[10px] hover:!text-[color:var(--color-rose)]"
                    >
                      delete
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}

          {/* Status / progress */}
          {importing && (
            <section className="px-4 py-3">
              <div className="t-ghost text-[10px] tracking-[0.25em] mb-1.5">// STATUS</div>
              <div className="flex items-start gap-2 text-[11px]">
                <span
                  className={
                    importing.status === 'done'
                      ? 't-phos'
                      : importing.status === 'error'
                        ? 't-warn'
                        : 't-amber pulse-amber'
                  }
                >
                  {importing.status === 'done' ? '●' : importing.status === 'error' ? '✕' : '○'}
                </span>
                <div className="flex-1">
                  <div className="t-mid">
                    {importing.vaultName} <span className="t-ghost">·</span> {importing.status}
                  </div>
                  <div className="t-ghost text-[10px] mt-0.5">{importing.message}</div>
                  {importing.errors.length > 0 && (
                    <details className="mt-1.5">
                      <summary className="t-warn text-[10px] cursor-pointer">
                        {importing.errors.length} error{importing.errors.length === 1 ? '' : 's'}
                      </summary>
                      <ul className="mt-1 max-h-32 overflow-auto">
                        {importing.errors.slice(0, 50).map((e, i) => (
                          <li key={i} className="t-dim text-[10px] truncate" title={e}>· {e}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-[var(--color-line)] flex items-center justify-end gap-2">
          <button onClick={close} className="btn text-[11px]">close</button>
        </div>
      </div>
    </div>
  )
}
