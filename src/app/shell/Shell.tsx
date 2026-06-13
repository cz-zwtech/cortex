import { useEffect } from 'react'
import { Sidebar } from './Sidebar'
import { SectionList } from './SectionList'
import { ListPane } from './ListPane'
import { EditPane } from './EditPane'
import { HomeView } from './HomeView'
import { KnowledgeView } from './KnowledgeView'
import { GraphView } from './GraphView'
import { CodeView } from './CodeView'
import { SessionsView } from './SessionsView'
import { MachinesView } from './MachinesView'
import { ProfileView } from './ProfileView'
import { useStore } from '@/app/store'
import {
  CommandPalette,
  ContextMenuHost,
  PromoteDialogHost,
  PromptHost,
  ScanDialogHost,
  SettingsDialog,
  SharedMindDialogHost,
  VaultImportDialogHost,
} from '@/ui-primitives'
import { Toaster, toast } from 'sonner'
import { buildPaletteActions } from '@/app/palette'
import { CRT } from '@/app/chrome/CRT'
import { TitleBar } from '@/app/chrome/TitleBar'
import { StatusBar } from '@/app/chrome/StatusBar'
import { IconRail } from '@/app/chrome/IconRail'
import { SelectionBar } from '@/app/chrome/SelectionBar'

export function Shell() {
  const bootstrap = useStore((s) => s.bootstrap)
  const ready = useStore((s) => s.ready)
  const lastError = useStore((s) => s.lastError)
  const addProject = useStore((s) => s.addProject)
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const view = useStore((s) => s.view)
  const profileEnabled = useStore((s) => s.profileEnabled)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // Global keyboard shortcuts: ⌘1-4 (Mac) / Ctrl+1-4 (others) jump between views.
  // Skip when the user is typing into a text field — the shortcuts shouldn't
  // hijack number entry in inputs/textareas/contenteditable.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const target = e.target as HTMLElement | null
      const editing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      if (editing) return
      const map: Record<string, 'home' | 'config' | 'knowledge' | 'graph' | 'code' | 'sessions' | 'machines' | 'profile'> = {
        '0': 'home',
        '1': 'config',
        '2': 'knowledge',
        '3': 'graph',
        '4': 'sessions',
        '5': 'code',
        '6': 'machines',
        '7': 'profile',
      }
      const next = map[e.key]
      if (!next) return
      if (next === 'profile' && !useStore.getState().profileEnabled) return
      e.preventDefault()
      // Toasting is handled by the store's setView so all entry points get it.
      useStore.getState().setView(next)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const actions = buildPaletteActions()

  if (!ready) {
    return (
      <CRT>
        <div className="h-full flex items-center justify-center t-dim text-sm">
          <span className="caret">booting cortex</span>
        </div>
      </CRT>
    )
  }

  return (
    <CRT>
      <TitleBar />
      {lastError && (
        <div className="bg-red-900/40 border-b border-red-800 text-red-200 text-xs px-4 py-1 shrink-0">
          {lastError}
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        <IconRail />
        <main className="flex-1 min-w-0 flex flex-col">
          <SelectionBar />
          <div className="flex-1 min-h-0 flex">
            {view === 'home' && <HomeView />}
            {view === 'config' && (
              <>
                <Sidebar />
                <SectionList />
                <ListPane />
                <EditPane />
              </>
            )}
            {view === 'knowledge' && <KnowledgeView />}
            {view === 'graph' && <GraphView />}
            {view === 'code' && <CodeView />}
            {view === 'sessions' && <SessionsView />}
            {view === 'machines' && <MachinesView />}
            {view === 'profile' && profileEnabled && <ProfileView />}
          </div>
        </main>
      </div>
      <StatusBar />
      <CommandPalette actions={actions} />
      <ContextMenuHost />
      <PromptHost />
      <ScanDialogHost
        onAdd={async (paths) => {
          for (const p of paths) await addProject(p)
          toast.success(`Added ${paths.length} project${paths.length === 1 ? '' : 's'}`)
        }}
      />
      <SettingsDialog settings={settings} onChange={updateSettings} />
      <VaultImportDialogHost />
      <PromoteDialogHost />
      <SharedMindDialogHost />
      <Toaster theme="dark" position="bottom-right" />
    </CRT>
  )
}
