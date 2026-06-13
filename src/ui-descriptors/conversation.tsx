import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Conversation } from '@/ontology'
import type { UiDescriptor } from './types'
import { parseConversationMessages, fetchToolResults, type ParsedMessage, type ToolUse } from '@/adapters'
import { MarkdownView, FilePath as CopyablePath } from '@/ui-primitives'
import { cn } from '@/ui-primitives'
import { useShikiLang, langFromPath, tokenizeLineSync, highlightLineHtml } from '@/ui-primitives/markdown/shikiSync'

// Scoped to a conversation viewer so nested components (ToolPreview, modal,
// etc.) can fetch lazy tool results without prop-drilling the file path.
const ConversationFileContext = createContext<string>('')

/**
 * Returns the tool_result string for the given tool_use id.
 * Returns null until it resolves. First call for a conversation kicks off
 * the shared background fetch; subsequent calls read from cache.
 */
const useToolResult = (toolId: string): string | null => {
  const filePath = useContext(ConversationFileContext)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    if (!filePath || !toolId) return
    let cancelled = false
    fetchToolResults(filePath)
      .then((map) => {
        if (cancelled) return
        const v = map.get(toolId)
        if (v !== undefined) setResult(v)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [filePath, toolId])

  return result
}

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `~${(n / 1_000_000).toFixed(1)}m` : n >= 1_000 ? `~${(n / 1_000).toFixed(1)}k` : `~${n}`

const formatDate = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

// ── Shared primitives ─────────────────────────────────────────────────────────

const toolBadgeClass = (name: string): string => {
  switch (name) {
    case 'Write':     return 'bg-emerald-950/70 text-emerald-400'
    case 'Edit':      return 'bg-amber-950/70 text-amber-400'
    case 'Bash':      return 'bg-yellow-950/70 text-yellow-400'
    case 'Grep':
    case 'Glob':      return 'bg-violet-950/70 text-violet-400'
    case 'WebFetch':
    case 'WebSearch': return 'bg-sky-950/70 text-sky-400'
    case 'Agent':     return 'bg-teal-950/70 text-teal-400'
    default:          return 'bg-zinc-700/60 text-zinc-300'
  }
}

function ToolBadge({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center text-[10px] font-bold font-mono uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0', className)}>
      {children}
    </span>
  )
}

function FilePath({ path, children }: { path: string; children?: React.ReactNode }) {
  return (
    <CopyablePath path={path} className="text-[12px] text-zinc-400 break-all">
      {children}
    </CopyablePath>
  )
}

const toolPrimaryLabel = (tool: ToolUse): string => {
  const { name, input } = tool
  switch (name) {
    case 'Read': case 'Write': case 'Edit': return input.file_path ?? ''
    case 'Bash':      return input.command ?? ''
    case 'Grep':      return `/${input.pattern}/`
    case 'Glob':      return input.pattern ?? ''
    case 'WebFetch':  return input.url ?? ''
    case 'WebSearch': return input.query ?? ''
    case 'Agent':     return input.description ?? ''
    default:          return ''
  }
}

// ── User bubble ───────────────────────────────────────────────────────────────

const UserBubble = memo(function UserBubble({ msg }: { msg: ParsedMessage }) {
  return (
    <div className="rounded-lg overflow-hidden min-w-0 bg-zinc-800">
      <div className="flex items-center gap-2.5 px-4 py-2 border-b bg-orange-500/10 border-orange-500/20">
        <span className="text-xs font-bold uppercase tracking-wider text-orange-400">You</span>
        <span className="text-[11px] text-zinc-500">{new Date(msg.timestamp).toLocaleTimeString()}</span>
      </div>
      <div className="px-4 py-3.5">
        {msg.textBlocks.map((text, i) => (
          <div key={i} className="md-preview conversation-prose text-sm">
            <MarkdownView value={text} />
          </div>
        ))}
      </div>
    </div>
  )
})

// ── Tool detail modal ─────────────────────────────────────────────────────────

function ModalSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1.5">{label}</div>
      {children}
    </div>
  )
}

function CodePre({ content }: { content: string }) {
  return (
    <pre className="bg-zinc-950 border border-zinc-800 rounded-md p-3 text-[12px] font-mono text-zinc-300 overflow-x-auto whitespace-pre-wrap break-words leading-relaxed">
      {content}
    </pre>
  )
}

function EditDiffView({ filePath, oldStr, newStr }: { filePath: string; oldStr: string; newStr: string }) {
  const lang = langFromPath(filePath)
  const highlighter = useShikiLang(lang)

  const renderContent = (source: string): React.ReactElement => {
    if (!highlighter) return <span>{source}</span>
    const html = highlightLineHtml(highlighter, source, lang)
    return <span dangerouslySetInnerHTML={{ __html: html }} />
  }

  return (
    <div className="border border-zinc-800 rounded-md overflow-hidden text-[12px] font-mono">
      <ReactDiffViewer
        oldValue={oldStr}
        newValue={newStr}
        splitView
        useDarkTheme
        showDiffOnly={false}
        hideSummary
        compareMethod={DiffMethod.WORDS}
        renderContent={renderContent}
        styles={{
          variables: {
            dark: {
              diffViewerBackground: '#0a0a0a',
              diffViewerColor: '#e4e4e7',
              addedBackground: 'rgba(16, 185, 129, 0.12)',
              addedColor: '#d1fae5',
              removedBackground: 'rgba(239, 68, 68, 0.12)',
              removedColor: '#fecaca',
              wordAddedBackground: 'rgba(16, 185, 129, 0.35)',
              wordRemovedBackground: 'rgba(239, 68, 68, 0.35)',
              addedGutterBackground: 'rgba(16, 185, 129, 0.18)',
              removedGutterBackground: 'rgba(239, 68, 68, 0.18)',
              gutterBackground: '#09090b',
              gutterBackgroundDark: '#09090b',
              highlightBackground: 'rgba(251, 146, 60, 0.08)',
              highlightGutterBackground: 'rgba(251, 146, 60, 0.12)',
              codeFoldGutterBackground: '#18181b',
              codeFoldBackground: '#18181b',
              emptyLineBackground: '#0a0a0a',
              gutterColor: '#52525b',
              addedGutterColor: '#34d399',
              removedGutterColor: '#f87171',
              codeFoldContentColor: '#a1a1aa',
              diffViewerTitleBackground: '#18181b',
              diffViewerTitleColor: '#e4e4e7',
              diffViewerTitleBorderColor: '#27272a',
            },
          },
        }}
      />
    </div>
  )
}

function ToolDetailContent({ tool }: { tool: ToolUse }) {
  const { name, input } = tool
  const result = useToolResult(tool.id)
  switch (name) {
    case 'Read':
      return (
        <>
          <ModalSection label="File"><FilePath path={input.file_path ?? ''} /></ModalSection>
          {result && <ModalSection label="Content"><CodePre content={result} /></ModalSection>}
        </>
      )
    case 'Write':
      return (
        <>
          <ModalSection label="File"><FilePath path={input.file_path ?? ''} /></ModalSection>
          {input.content && <ModalSection label="Content"><CodePre content={input.content} /></ModalSection>}
        </>
      )
    case 'Edit':
      return (
        <>
          <ModalSection label="File"><FilePath path={input.file_path ?? ''} /></ModalSection>
          <ModalSection label="Diff">
            <EditDiffView
              filePath={input.file_path ?? ''}
              oldStr={input.old_string ?? ''}
              newStr={input.new_string ?? ''}
            />
          </ModalSection>
        </>
      )
    case 'Bash':
      return (
        <>
          <ModalSection label="Command"><CodePre content={input.command} /></ModalSection>
          {result && <ModalSection label="Output"><CodePre content={result} /></ModalSection>}
        </>
      )
    case 'Grep':
      return (
        <>
          <ModalSection label="Pattern">
            <span className="text-[12px] font-mono text-zinc-300">/{input.pattern}/</span>
            {input.path && <span className="text-[12px] text-zinc-500 ml-2">in <FilePath path={input.path} /></span>}
          </ModalSection>
          {result && <ModalSection label="Matches"><CodePre content={result} /></ModalSection>}
        </>
      )
    case 'Glob':
      return (
        <>
          <ModalSection label="Pattern"><FilePath path={input.pattern ?? ''} /></ModalSection>
          {result && <ModalSection label="Results"><CodePre content={result} /></ModalSection>}
        </>
      )
    case 'WebFetch':
      return (
        <>
          <ModalSection label="URL"><FilePath path={input.url ?? ''} /></ModalSection>
          {result && <ModalSection label="Content"><CodePre content={result} /></ModalSection>}
        </>
      )
    case 'WebSearch':
      return (
        <>
          <ModalSection label="Query"><span className="text-[12px] text-zinc-300">{input.query}</span></ModalSection>
          {result && <ModalSection label="Results"><CodePre content={result} /></ModalSection>}
        </>
      )
    case 'Agent':
      return (
        <>
          {input.description && <ModalSection label="Description"><span className="text-sm text-zinc-300">{input.description}</span></ModalSection>}
          {input.prompt && <ModalSection label="Prompt"><CodePre content={input.prompt} /></ModalSection>}
          {result && <ModalSection label="Result"><CodePre content={result} /></ModalSection>}
        </>
      )
    case 'TodoWrite': {
      const todos: any[] = Array.isArray(input.todos) ? input.todos : []
      const statusLabel = (s: string) => s === 'completed' ? 'done' : s === 'in_progress' ? 'active' : 'pending'
      const statusColor = (s: string) => s === 'completed' ? 'text-emerald-400' : s === 'in_progress' ? 'text-amber-400' : 'text-zinc-500'
      return (
        <ModalSection label={`Tasks (${todos.length})`}>
          <div className="space-y-1.5">
            {todos.map((t, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <span className={cn('text-[10px] font-mono uppercase tracking-wider mt-0.5 shrink-0', statusColor(t.status))}>{statusLabel(t.status)}</span>
                <span className="text-zinc-300">{t.content}</span>
              </div>
            ))}
          </div>
        </ModalSection>
      )
    }
    default:
      return (
        <>
          <ModalSection label="Input"><CodePre content={JSON.stringify(input, null, 2)} /></ModalSection>
          {result && <ModalSection label="Result"><CodePre content={result} /></ModalSection>}
        </>
      )
  }
}

function ToolDetailModal({ tool, onClose }: { tool: ToolUse; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const label = toolPrimaryLabel(tool)

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="w-full max-w-6xl max-h-[85vh] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 shrink-0">
          <ToolBadge className={toolBadgeClass(tool.name)}>{tool.name}</ToolBadge>
          {label && <CopyablePath path={label} className="text-[12px] text-zinc-400 truncate" />}
          <button className="ml-auto text-zinc-500 hover:text-zinc-200 transition-colors text-lg leading-none" onClick={onClose}>✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 space-y-4">
          <ToolDetailContent tool={tool} />
        </div>
      </div>
    </div>
  )
}

// ── Line diff (LCS-based) ─────────────────────────────────────────────────────

type DiffOp = { type: 'equal' | 'remove' | 'add'; line: string }

const lineDiff = (oldText: string, newText: string): DiffOp[] => {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const m = a.length, n = b.length
  const w = n + 1
  const lcs = new Int32Array((m + 1) * w)
  const at = (i: number, j: number): number => lcs[i * w + j] ?? 0
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const ai = a[i], bj = b[j]
      if (ai === undefined || bj === undefined) continue
      lcs[i * w + j] = ai === bj ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }

  const ops: DiffOp[] = []
  let i = 0, j = 0
  while (i < m && j < n) {
    const ai = a[i], bj = b[j]
    if (ai === undefined || bj === undefined) break
    if (ai === bj)                         { ops.push({ type: 'equal',  line: ai }); i++; j++ }
    else if (at(i + 1, j) >= at(i, j + 1)) { ops.push({ type: 'remove', line: ai }); i++ }
    else                                   { ops.push({ type: 'add',    line: bj }); j++ }
  }
  while (i < m) {
    const ai = a[i]
    if (ai === undefined) break
    ops.push({ type: 'remove', line: ai })
    i++
  }
  while (j < n) {
    const bj = b[j]
    if (bj === undefined) break
    ops.push({ type: 'add', line: bj })
    j++
  }
  return ops
}

type DiffRow = { left: string | null; right: string | null; changed: boolean }

const alignDiff = (ops: DiffOp[]): DiffRow[] => {
  const rows: DiffRow[] = []
  let i = 0
  while (i < ops.length) {
    const op = ops[i]
    if (op === undefined) break
    if (op.type === 'equal') {
      rows.push({ left: op.line, right: op.line, changed: false })
      i++
      continue
    }
    const removes: string[] = []
    const adds: string[] = []
    while (i < ops.length) {
      const next = ops[i]
      if (next === undefined || next.type === 'equal') break
      if (next.type === 'remove') removes.push(next.line)
      else adds.push(next.line)
      i++
    }
    const max = Math.max(removes.length, adds.length)
    for (let k = 0; k < max; k++) {
      rows.push({
        left:  removes[k] ?? null,
        right: adds[k]    ?? null,
        changed: true,
      })
    }
  }
  return rows
}

// ── Timeline ──────────────────────────────────────────────────────────────────

/**
 * Bash-specific preview. Split out so its `useToolResult` call only runs for
 * actual Bash tools (hooks must be called unconditionally, and ToolPreview
 * handles many kinds). Fetches the tool_result lazily — only visible rows
 * pay the cost thanks to timeline virtualization.
 */
function BashPreview({ command, toolId, hl }: {
  command: string
  toolId: string
  hl: (line: string) => React.ReactNode
}) {
  const result = useToolResult(toolId)
  const outLines = result ? result.split('\n').filter(Boolean) : []
  const shown = outLines.slice(0, 6)
  const truncated = outLines.length > 6
  return (
    <div className="mt-1.5 border border-zinc-700/50 rounded overflow-hidden text-[11px] font-mono">
      <div className="px-2.5 py-1.5 bg-zinc-800/40 whitespace-pre-wrap break-all">
        {hl(command)}
      </div>
      {shown.length > 0 && (
        <>
          <div className="border-t border-zinc-700/50" />
          <div className="px-2.5 py-1.5 text-zinc-500 whitespace-pre-wrap">
            {shown.join('\n')}{truncated ? '\n…' : ''}
          </div>
        </>
      )}
    </div>
  )
}

function ToolPreview({ tool }: { tool: ToolUse }) {
  const { name, input } = tool

  const lang = (() => {
    if (name === 'Bash') return 'bash'
    if (name === 'Write' || name === 'Edit') return langFromPath(input.file_path ?? '')
    return 'text'
  })()
  const highlighter = useShikiLang(lang)

  const hl = (line: string): React.ReactNode => {
    if (!line) return line
    if (!highlighter) return line
    const tokens = tokenizeLineSync(highlighter, line, lang)
    if (!tokens) return line
    return tokens.map((t, i) => (
      <span key={i} style={{ color: t.color, fontStyle: t.fontStyle === 1 ? 'italic' : undefined }}>{t.content}</span>
    ))
  }

  if (name === 'Write' && typeof input.content === 'string' && input.content.length > 0) {
    const content: string = input.content
    const lines = content.split('\n')
    const shown = lines.slice(0, 5)
    const truncated = lines.length > 5
    return (
      <div className="mt-1.5 border border-zinc-700/50 rounded overflow-hidden">
        {shown.map((l, i) => (
          <div key={i} className="text-[11px] font-mono bg-emerald-950/20 px-2 leading-snug whitespace-pre">
            <span className="text-emerald-500/70">+ </span>{hl(l)}
          </div>
        ))}
        {truncated && <div className="text-[11px] font-mono text-zinc-600 px-2 py-0.5">…</div>}
      </div>
    )
  }

  if (name === 'Edit' && (input.old_string || input.new_string)) {
    const rows = alignDiff(lineDiff(input.old_string ?? '', input.new_string ?? ''))
    const MAX = 8
    const shown = rows.slice(0, MAX)
    const truncated = rows.length > MAX

    const cellBase = 'text-[11px] font-mono px-2 leading-snug whitespace-pre min-h-[18px]'

    return (
      <div className="mt-1.5 border border-zinc-700/50 rounded overflow-hidden">
        <div className="flex">
          <div className="flex-1 min-w-0 overflow-hidden">
            {shown.map((r, i) => (
              <div key={i} className={cn(
                cellBase,
                r.changed ? (r.left !== null ? 'bg-red-950/25' : 'bg-zinc-900/70') : '',
              )}>
                {r.left !== null
                  ? <><span className={r.changed ? 'text-red-400/90' : 'text-zinc-600'}>{r.changed ? '- ' : '  '}</span>{hl(r.left)}</>
                  : '\u00A0'}
              </div>
            ))}
          </div>
          <div className="w-px bg-zinc-700/50 shrink-0" />
          <div className="flex-1 min-w-0 overflow-hidden">
            {shown.map((r, i) => (
              <div key={i} className={cn(
                cellBase,
                r.changed ? (r.right !== null ? 'bg-emerald-950/25' : 'bg-zinc-900/70') : '',
              )}>
                {r.right !== null
                  ? <><span className={r.changed ? 'text-emerald-400/90' : 'text-zinc-600'}>{r.changed ? '+ ' : '  '}</span>{hl(r.right)}</>
                  : '\u00A0'}
              </div>
            ))}
          </div>
        </div>
        {truncated && (
          <div className="text-[10px] font-mono text-zinc-600 text-center py-0.5 border-t border-zinc-700/50 bg-zinc-900/40">
            … {rows.length - MAX} more row{rows.length - MAX === 1 ? '' : 's'}
          </div>
        )}
      </div>
    )
  }

  if (name === 'Bash') {
    return (
      <BashPreview command={input.command ?? ''} toolId={tool.id} hl={hl} />
    )
  }

  if (name === 'TodoWrite') {
    const todos: any[] = Array.isArray(input.todos) ? input.todos : []
    if (todos.length === 0) return null
    const statusSymbol = (s: string) => s === 'completed' ? '✓' : s === 'in_progress' ? '▶' : '○'
    const statusColor = (s: string) => s === 'completed' ? 'text-emerald-500' : s === 'in_progress' ? 'text-amber-400' : 'text-zinc-500'
    return (
      <div className="mt-1.5 border border-zinc-700/50 rounded overflow-hidden">
        {todos.map((t, i) => (
          <div key={i} className={cn(
            'flex items-start gap-2 px-2.5 py-1 text-[11px] font-mono',
            i > 0 && 'border-t border-zinc-800/60',
            statusColor(t.status),
          )}>
            <span className="shrink-0 text-zinc-500">{statusSymbol(t.status)}</span>
            <span>{t.content}</span>
          </div>
        ))}
      </div>
    )
  }

  return null
}

const ToolTimelineEntry = memo(function ToolTimelineEntry({ tool, onToolClick }: { tool: ToolUse; onToolClick: (t: ToolUse) => void }) {
  const { name, input } = tool

  const inlineLabel = (() => {
    switch (name) {
      case 'Bash':
      case 'TodoWrite':
        return null
      case 'Grep':
        return (
          <>
            <span className="text-[12px] font-mono text-zinc-400">/{input.pattern}/</span>
            {input.path && <FilePath path={input.path}> in {input.path}</FilePath>}
          </>
        )
      default: {
        const label = toolPrimaryLabel(tool)
        return label ? <FilePath path={label} /> : null
      }
    }
  })()

  return (
    <div className="relative">
      <div className="absolute z-10 -left-7 top-[4px] w-2 h-2 rounded-full bg-zinc-500" />
      <div
        className="cursor-pointer hover:bg-white/[0.04] rounded px-1 -mx-1 py-0.5 transition-colors"
        onClick={() => onToolClick(tool)}
      >
        <div className="flex items-baseline gap-2 flex-wrap">
          <ToolBadge className={toolBadgeClass(name)}>{name}</ToolBadge>
          {inlineLabel}
        </div>
        <ToolPreview tool={tool} />
      </div>
    </div>
  )
})

const TextTimelineEntry = memo(function TextTimelineEntry({ content }: { content: string }) {
  return (
    <div className="relative pt-3">
      <div className="absolute z-10 -left-7 top-[16px] w-2 h-2 rounded-full bg-sky-500" />
      <div className="text-[10px] font-bold uppercase tracking-wider text-sky-600/70 mb-2">Claude says</div>
      <div className="md-preview conversation-prose text-sm">
        <MarkdownView value={content} />
      </div>
    </div>
  )
})

// ── Data grouping ─────────────────────────────────────────────────────────────

type TimelineEvent =
  | { type: 'tool'; tool: ToolUse }
  | { type: 'text'; content: string }

type RenderGroup =
  | { type: 'user'; msg: ParsedMessage }
  | { type: 'assistant'; events: TimelineEvent[]; key: string }

const buildRenderGroups = (msgs: ParsedMessage[]): RenderGroup[] => {
  const groups: RenderGroup[] = []
  for (const m of msgs) {
    if (m.role === 'user') {
      groups.push({ type: 'user', msg: m })
    } else {
      const events: TimelineEvent[] = [
        ...m.toolUses.map(tool => ({ type: 'tool' as const, tool })),
        ...m.textBlocks.map(content => ({ type: 'text' as const, content })),
      ]
      if (events.length === 0) continue
      const last = groups[groups.length - 1]
      if (last?.type === 'assistant') {
        last.events.push(...events)
      } else {
        groups.push({ type: 'assistant', events, key: m.uuid })
      }
    }
  }
  return groups
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  // Deterministic widths so the skeleton doesn't shimmer differently on re-render
  const toolWidths = [55, 38, 72, 44, 60]
  const textWidths = [85, 70, 50]
  return (
    <div className="max-w-4xl mx-auto min-w-0 px-5 py-4 animate-pulse space-y-4">
      {/* Fake user bubble */}
      <div className="rounded-lg bg-zinc-800/60 overflow-hidden">
        <div className="bg-orange-500/10 border-b border-orange-500/20 px-4 py-2 flex items-center gap-2.5">
          <div className="h-2.5 w-8 bg-orange-400/30 rounded" />
          <div className="h-2 w-14 bg-zinc-700 rounded" />
        </div>
        <div className="px-4 py-3.5 space-y-2">
          <div className="h-3 bg-zinc-700/60 rounded w-3/4" />
          <div className="h-3 bg-zinc-700/60 rounded w-1/2" />
        </div>
      </div>

      {/* Fake timeline: tool events then a text event */}
      <div className="ml-1">
        {toolWidths.map((w, i) => (
          <div key={`t-${i}`} className="relative pl-6 border-l border-zinc-700/50 py-2">
            <div className="absolute z-10 -left-7 top-[10px] w-2 h-2 rounded-full bg-zinc-500" />
            <div className="flex items-center gap-2">
              <div className="h-3.5 w-12 bg-zinc-700 rounded-sm" />
              <div className="h-2.5 bg-zinc-700/50 rounded" style={{ width: `${w}%` }} />
            </div>
          </div>
        ))}
        <div className="relative pl-6 border-l border-zinc-700/50 pt-5 pb-3">
          <div className="absolute z-10 -left-7 top-[22px] w-2 h-2 rounded-full bg-sky-500" />
          <div className="h-2.5 w-20 bg-sky-600/40 rounded mb-3" />
          <div className="space-y-2">
            {textWidths.map((w, i) => (
              <div key={`x-${i}`} className="h-3 bg-zinc-700/50 rounded" style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Viewer ────────────────────────────────────────────────────────────────────
//
// Renders the conversation as a virtualized flat list. Each assistant "turn"
// is fanned out into its individual events (tool calls + text blocks) so the
// virtualizer sees them as independent rows — mounting only what's on screen
// instead of the whole transcript up front. The continuous timeline "line"
// that connects dots is re-created per row via `border-l` on each timeline
// row's wrapper; adjacent rows sit flush so the border visually continues.

type FlatRow =
  | { kind: 'user'; msg: ParsedMessage; key: string }
  | { kind: 'tool'; tool: ToolUse; key: string }
  | { kind: 'text'; content: string; key: string }

const flattenGroups = (groups: RenderGroup[]): FlatRow[] => {
  const out: FlatRow[] = []
  for (const g of groups) {
    if (g.type === 'user') {
      out.push({ kind: 'user', msg: g.msg, key: g.msg.uuid || `u-${out.length}` })
      continue
    }
    g.events.forEach((e, j) => {
      const key = `${g.key}:${j}`
      if (e.type === 'tool') out.push({ kind: 'tool', tool: e.tool, key })
      else                   out.push({ kind: 'text', content: e.content, key })
    })
  }
  return out
}

const Row = memo(function Row({ row, onToolClick }: { row: FlatRow; onToolClick: (t: ToolUse) => void }) {
  if (row.kind === 'user') {
    return <div className="py-2"><UserBubble msg={row.msg} /></div>
  }
  const inner = row.kind === 'tool'
    ? <ToolTimelineEntry tool={row.tool} onToolClick={onToolClick} />
    : <TextTimelineEntry content={row.content} />
  return (
    <div className="relative pl-6 border-l border-zinc-700/50 ml-1 py-2">
      {inner}
    </div>
  )
})

/** Walks up the DOM until it finds a vertically-scrolling ancestor. */
const findScrollParent = (el: HTMLElement | null): HTMLElement | null => {
  let node: HTMLElement | null = el?.parentElement ?? null
  while (node) {
    const s = getComputedStyle(node)
    if (s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflowY === 'overlay') return node
    node = node.parentElement
  }
  return null
}

function ConversationViewer({ value }: { value: Conversation; onChange: any; ctx: any }) {
  const [messages, setMessages] = useState<ParsedMessage[] | null>(null)
  const [selectedTool, setSelectedTool] = useState<ToolUse | null>(null)
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setMessages(null)
    parseConversationMessages(value.filePath)
      .then((m) => { if (!cancelled) setMessages(m) })
      .catch(() => { if (!cancelled) setMessages([]) })
    return () => { cancelled = true }
  }, [value.filePath])

  useLayoutEffect(() => {
    setScrollParent(findScrollParent(anchorRef.current))
  }, [])

  const handleToolClick = useCallback((t: ToolUse) => setSelectedTool(t), [])

  const rows = useMemo<FlatRow[]>(
    () => (messages ? flattenGroups(buildRenderGroups(messages)) : []),
    [messages],
  )

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollParent,
    estimateSize: () => 96,
    overscan: 6,
    getItemKey: (i) => rows[i]?.key ?? i,
  })

  if (messages === null) {
    return <div ref={anchorRef}><LoadingSkeleton /></div>
  }
  if (messages.length === 0) {
    return <div ref={anchorRef} className="p-6 text-zinc-500 text-sm">No messages found.</div>
  }

  const items = virtualizer.getVirtualItems()

  return (
    <ConversationFileContext.Provider value={value.filePath}>
      <div ref={anchorRef} className="max-w-4xl mx-auto min-w-0">
        <div
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((vi) => {
            const row = rows[vi.index]
            if (!row) return null
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <Row row={row} onToolClick={handleToolClick} />
              </div>
            )
          })}
        </div>
      </div>
      {selectedTool && (
        <ToolDetailModal tool={selectedTool} onClose={() => setSelectedTool(null)} />
      )}
    </ConversationFileContext.Provider>
  )
}

export const conversationDescriptor: UiDescriptor<Conversation> = {
  kind: 'conversation',
  newLabel: '',
  newPromptLabel: '',
  newDefault: () => ({
    sessionId: '', title: '', startTime: '', lastTime: '', turnCount: 0, projectDir: '', filePath: '',
  }),
  listLabel: (v) => v.title || v.sessionId,
  listSublabel: (v) => {
    const parts: string[] = []
    if (v.lastTime) parts.push(formatDate(v.lastTime))
    if (v.turnCount) parts.push(`${v.turnCount} turn${v.turnCount === 1 ? '' : 's'}`)
    if (v.tokenCount) parts.push(`${fmtTokens(v.tokenCount)} tokens`)
    return parts.join(' · ')
  },
  Editor: ConversationViewer,
}
