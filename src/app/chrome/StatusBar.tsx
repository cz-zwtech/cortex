import { useStore } from '@/app/store'

export function StatusBar() {
  const view = useStore((s) => s.view)
  const scope = useStore((s) => s.scope)
  const stats = useStore((s) => s.graphStats)

  const scopeLabel = scope.type === 'user' ? '~/.claude' : scope.type === 'project' ? scope.projectId : '—'
  const memLabel = stats ? `${stats.nodes.toLocaleString()} nodes · ${stats.edges.toLocaleString()} edges` : '—'

  const left: { k: string; v: string; tone?: 'amber' | 'phos' }[] = [
    { k: 'VIEW', v: view },
    { k: 'SCOPE', v: scopeLabel },
    { k: 'MEMORY', v: memLabel, tone: 'phos' },
  ]
  const right = [
    { k: '⌘0', v: 'home' },
    { k: '⌘1', v: 'config' },
    { k: '⌘2', v: 'knowledge' },
    { k: '⌘3', v: 'graph' },
    { k: '⌘4', v: 'sessions' },
    { k: '⌘K', v: 'cmd' },
  ]

  return (
    <div
      className="flex items-center gap-3.5 px-3 shrink-0 border-t border-[var(--color-line)] text-[10px] tracking-[0.05em]"
      style={{ height: 22, background: '#07081a' }}
    >
      {left.map((i) => (
        <span key={i.k}>
          <span className="t-ghost">{i.k}</span>{' '}
          <span className={i.tone === 'phos' ? 't-phos' : i.tone === 'amber' ? 't-amber' : 't-mid'}>{i.v}</span>
        </span>
      ))}
      <span className="flex-1" />
      <span className="t-phos pulse-phos mr-2">● READY</span>
      {right.map((i) => (
        <span key={i.k} className="t-dim">
          <span className="t-mid">{i.k}</span> {i.v}
        </span>
      ))}
    </div>
  )
}
