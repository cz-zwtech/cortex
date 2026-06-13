import { useEffect, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'
import { useStore } from '@/app/store'
import { MarkdownView } from './markdown/MarkdownView'
import { cn } from './util'

interface Props {
  value: string
  onChange: (v: string) => void
  minHeight?: string
}

export function ProseEditor({ value, onChange, minHeight = '200px' }: Props) {
  const defaultMode = useStore((s) => s.settings.markdownDefaultMode)
  const [read, setRead] = useState(defaultMode === 'read')
  useEffect(() => {
    setRead(defaultMode === 'read')
  }, [defaultMode])
  const safe = value ?? ''
  return (
    <div className="relative rounded border border-zinc-800 bg-zinc-950">
      <div className="absolute top-1 right-1 z-10 flex gap-0.5 rounded bg-zinc-900/90 border border-zinc-800 overflow-hidden">
        <ToggleButton active={!read} onClick={() => setRead(false)}>
          Edit
        </ToggleButton>
        <ToggleButton active={read} onClick={() => setRead(true)}>
          Read
        </ToggleButton>
      </div>
      {read ? (
        <div className="md-preview px-5 py-4 overflow-auto" style={{ minHeight }}>
          {safe.trim() ? (
            <MarkdownView value={safe} />
          ) : (
            <div className="text-zinc-600 italic text-sm">Nothing to preview.</div>
          )}
        </div>
      ) : (
        <CodeMirror
          value={safe}
          onChange={onChange}
          theme={oneDark}
          extensions={[markdown(), EditorView.lineWrapping]}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
          }}
          style={{ minHeight }}
        />
      )}
    </div>
  )
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-xs px-2 py-0.5 transition-colors',
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200',
      )}
    >
      {children}
    </button>
  )
}
