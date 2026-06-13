import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { relPath } from '@/adapters'
import { FilePath } from './FilePath'

export interface ScanHit {
  path: string
  has_claude_md: boolean
  has_claude_dir: boolean
}

interface ScanStore {
  open: boolean
  root: string
  hits: ScanHit[]
  scanning: boolean
  begin: (root: string, scan: (root: string) => Promise<ScanHit[]>) => Promise<void>
  close: () => void
}

const useScanStore = create<ScanStore>((set) => ({
  open: false,
  root: '',
  hits: [],
  scanning: false,
  begin: async (root, scan) => {
    set({ open: true, root, hits: [], scanning: true })
    try {
      const hits = await scan(root)
      set({ hits, scanning: false })
    } catch (e) {
      set({ scanning: false })
      throw e
    }
  },
  close: () => set({ open: false, root: '', hits: [], scanning: false }),
}))

export const openScanDialog = async (
  root: string,
  scan: (root: string) => Promise<ScanHit[]>,
): Promise<void> => {
  await useScanStore.getState().begin(root, scan)
}

interface Props {
  onAdd: (paths: string[]) => Promise<void>
}

export function ScanDialogHost({ onAdd }: Props) {
  const { open, root, hits, scanning, close } = useScanStore()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (open) setSelected(new Set(hits.map((h) => h.path)))
  }, [open, hits])

  if (!open) return null

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const allSelected = hits.length > 0 && hits.every((h) => selected.has(h.path))
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(hits.map((h) => h.path)))
  }

  const handleAdd = async () => {
    await onAdd([...selected])
    close()
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[10vh]"
      onClick={close}
    >
      <div
        className="w-[640px] max-w-[90vw] max-h-[80vh] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-sm">Discovered projects</div>
            <FilePath path={root} className="text-xs text-zinc-500 truncate" />
          </div>
          <div className="text-xs text-zinc-500">
            {scanning ? 'scanning…' : `${hits.length} found`}
          </div>
        </header>

        {hits.length > 0 && (
          <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              Select all
            </label>
            <span className="text-xs text-zinc-500">{selected.size} selected</span>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {scanning && hits.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">Scanning…</div>
          )}
          {!scanning && hits.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              No projects with CLAUDE.md or .claude/ found.
            </div>
          )}
          <ul>
            {hits.map((h) => (
              <li key={h.path}>
                <label className="flex items-center gap-3 px-4 py-2 hover:bg-zinc-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(h.path)}
                    onChange={() => toggle(h.path)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate font-mono">{relPath(h.path, root)}</div>
                    <div className="text-[10px] text-zinc-500 flex gap-2 mt-0.5">
                      {h.has_claude_md && <Tag>CLAUDE.md</Tag>}
                      {h.has_claude_dir && <Tag>.claude/</Tag>}
                    </div>
                  </div>
                </label>
              </li>
            ))}
          </ul>
        </div>

        <footer className="px-4 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button
            onClick={close}
            className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100"
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={selected.size === 0}
            className="px-3 py-1.5 text-sm bg-orange-500 text-zinc-950 rounded hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add {selected.size || ''}
          </button>
        </footer>
      </div>
    </div>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-[10px]">
      {children}
    </span>
  )
}
