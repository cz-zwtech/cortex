/**
 * SharedMindDialog — manage the shared-mind publish queue + git ops in one
 * place. Queue rows let the user remove items before publishing; the
 * footer carries Publish (drains queue → commit + push) and Sync (pull +
 * import memories into the graph).
 *
 * Hosted as a single modal that the IconRail opens. Writes go through the
 * store actions so other surfaces (e.g. queue count badge) reactively
 * update.
 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useStore } from '@/app/store'
import type { SharedQueueItem } from '@/adapters/sharedMind'

interface DialogStore {
  open: boolean
  setOpen: (open: boolean) => void
}

const useDialog = create<DialogStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

export const openSharedMindDialog = (): void => useDialog.getState().setOpen(true)

const KIND_TONE: Record<SharedQueueItem['kind'], string> = {
  memory: 'var(--color-phos)',
  skill: 'var(--color-amber)',
  agent: 'var(--color-amber)',
  command: 'var(--color-cyan)',
  rule: 'var(--color-cyan)',
  permission: 'var(--color-rose)',
  hook: 'var(--color-rose)',
  mcp: 'var(--color-warn)',
}

const formatRelative = (ms: number): string => {
  const diff = Date.now() - ms
  if (diff < 0) return 'now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function SharedMindDialogHost() {
  const open = useDialog((s) => s.open)
  const setOpen = useDialog((s) => s.setOpen)

  const status = useStore((s) => s.sharedStatus)
  const queue = useStore((s) => s.sharedQueue)
  const manifest = useStore((s) => s.sharedManifest)
  const busy = useStore((s) => s.sharedBusy)
  const message = useStore((s) => s.sharedLastMessage)
  const refresh = useStore((s) => s.refreshSharedMind)
  const publish = useStore((s) => s.publishShared)
  const sync = useStore((s) => s.syncShared)
  const setRemote = useStore((s) => s.setSharedRemote)
  const setManifest = useStore((s) => s.setSharedManifest)

  const [remoteInput, setRemoteInput] = useState('')
  const [nameInput, setNameInput] = useState('')
  const [descInput, setDescInput] = useState('')

  // Pull fresh status whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  // Sync local form state with manifest on load.
  useEffect(() => {
    if (!open) return
    setRemoteInput(status?.remoteUrl ?? '')
    setNameInput(manifest?.name ?? '')
    setDescInput(manifest?.description ?? '')
  }, [open, status?.remoteUrl, manifest?.name, manifest?.description])

  if (!open) return null

  const handleSetRemote = async () => {
    if (!remoteInput.trim()) return
    try {
      await setRemote(remoteInput.trim())
    } catch {}
  }

  const handleSaveManifest = async () => {
    await setManifest({ name: nameInput.trim(), description: descInput.trim() })
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(7,8,26,0.85)', backdropFilter: 'blur(2px)' }}
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[760px] max-h-[85vh] flex flex-col"
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
          <span className="vt t-amber t-glow-amber tracking-[0.18em] text-[14px]">
            ◈ SHARED MIND
          </span>
          <span className="t-ghost">│</span>
          <span className="t-dim text-[11px] flex-1">
            Publish memories + tools to the higher consciousness
          </span>
          <button
            onClick={() => void refresh()}
            className="btn t-ghost text-[10px]"
            title="Refresh status"
          >
            ↻
          </button>
          <button
            onClick={() => setOpen(false)}
            className="btn t-ghost text-[14px] leading-none px-2"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {/* Status bar */}
          <section className="px-4 py-3 border-b border-[var(--color-line)] flex items-center gap-3 text-[11px]">
            <StatusDot
              tone={!status ? 'dim' : !status.initialized ? 'dim' : !status.hasRemote ? 'warn' : 'phos'}
            />
            <div className="flex-1 min-w-0">
              <div className="t-mid truncate">
                {!status?.initialized
                  ? 'not initialized — opening will create the working clone'
                  : !status.hasRemote
                    ? 'local clone ready · no remote configured'
                    : `${status.branch ?? 'main'} · ↑${status.ahead} ↓${status.behind}${status.dirty ? ' · dirty' : ''}`}
              </div>
              <div className="t-ghost text-[10px] truncate">
                {status?.localPath ?? '—'}
                {status?.remoteUrl ? `  →  ${status.remoteUrl}` : ''}
              </div>
            </div>
            <div className="t-ghost text-[10px] tabular-nums">
              {status?.memoryCount ?? 0} mem · {status?.artifactCount ?? 0} art
            </div>
          </section>

          {/* Manifest */}
          <section className="px-4 py-3 border-b border-[var(--color-line)]">
            <div className="t-ghost text-[10px] tracking-[0.25em] mb-2">// MANIFEST</div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="t-ghost text-[10px] w-16">name</span>
                <input
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="display name (used as `shared:<name>` scope)"
                  className="flex-1 bg-transparent outline-none px-2 py-1 text-[11px] t-mid placeholder:text-[color:var(--color-ghost)]"
                  style={{ border: '1px solid var(--color-line)' }}
                />
              </div>
              <div className="flex items-start gap-2">
                <span className="t-ghost text-[10px] w-16 mt-1">description</span>
                <textarea
                  value={descInput}
                  onChange={(e) => setDescInput(e.target.value)}
                  placeholder="what this shared mind is about"
                  rows={2}
                  className="flex-1 bg-transparent outline-none px-2 py-1 text-[11px] t-mid placeholder:text-[color:var(--color-ghost)] resize-none"
                  style={{ border: '1px solid var(--color-line)' }}
                />
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => void handleSaveManifest()}
                  className="btn text-[10px]"
                  disabled={busy}
                >
                  save manifest
                </button>
              </div>
            </div>
          </section>

          {/* Remote config */}
          <section className="px-4 py-3 border-b border-[var(--color-line)]">
            <div className="t-ghost text-[10px] tracking-[0.25em] mb-2">// REMOTE</div>
            <div className="flex items-center gap-2">
              <span className="t-ghost text-[10px] w-16">origin</span>
              <input
                value={remoteInput}
                onChange={(e) => setRemoteInput(e.target.value)}
                placeholder="git@github.com:your-org/your-shared-mind.git"
                className="flex-1 bg-transparent outline-none px-2 py-1 text-[11px] t-mid placeholder:text-[color:var(--color-ghost)] font-mono"
                style={{ border: '1px solid var(--color-line)' }}
              />
              <button
                onClick={() => void handleSetRemote()}
                className="btn text-[10px]"
                disabled={busy || !remoteInput.trim()}
              >
                set
              </button>
            </div>
          </section>

          {/* Queue */}
          <section className="px-4 py-3 border-b border-[var(--color-line)]">
            <div className="flex items-center mb-2">
              <span className="t-ghost text-[10px] tracking-[0.25em] flex-1">
                // QUEUE · {queue.length} pending
              </span>
              {queue.length > 0 && (
                <span className="t-amber text-[10px]">ready to publish</span>
              )}
            </div>
            {queue.length === 0 ? (
              <div className="t-dim text-[11px] italic">
                Empty. Add items by clicking <span className="t-amber">share →</span> on a memory or
                config entity in the editor.
              </div>
            ) : (
              <div className="flex flex-col">
                {queue.map((item) => (
                  <QueueRow key={item.id} item={item} />
                ))}
              </div>
            )}
          </section>

          {/* Status / progress */}
          {message && (
            <section className="px-4 py-2 border-b border-[var(--color-line)] text-[11px]">
              <span className={busy ? 't-amber pulse-amber' : 't-mid'}>{message}</span>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[var(--color-line)] flex items-center gap-2">
          <button
            onClick={() => void sync()}
            className="btn text-[11px]"
            disabled={busy}
            title="Pull from remote and import memories into the graph"
          >
            ↓ sync
          </button>
          <span className="flex-1" />
          <button onClick={() => setOpen(false)} className="btn t-ghost text-[11px]">
            close
          </button>
          <button
            onClick={() => void publish({ push: true })}
            disabled={busy || queue.length === 0}
            className="btn text-[11px] !text-[color:var(--color-phos)] !border-[color:var(--color-phos-dim)] hover:!border-[color:var(--color-phos)] disabled:opacity-40"
            title="Drain queue, commit, and push to origin"
          >
            ↑ publish queue
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Single queue row. Collapsed → one-liner with kind + title + remove.
 * Expanded → editable title, editable description, optional body
 * override (full functional memory body — auto-generated unless the user
 * supplies their own).
 *
 * Edits save on blur via the `editQueuedShared` action so the user's
 * refinements persist across dialog closes.
 */
function QueueRow({ item }: { item: SharedQueueItem }) {
  const editQueued = useStore((s) => s.editQueuedShared)
  const unqueue = useStore((s) => s.unqueueShared)
  const [expanded, setExpanded] = useState(false)
  const [title, setTitle] = useState(item.title)
  const [description, setDescription] = useState(item.description ?? '')
  const [bodyOverride, setBodyOverride] = useState(item.bodyOverride ?? '')

  // Re-sync local state if the queue item changes from outside (e.g. another
  // window) — common case is the user re-clicking "share →" with new values.
  useEffect(() => {
    setTitle(item.title)
    setDescription(item.description ?? '')
    setBodyOverride(item.bodyOverride ?? '')
  }, [item.title, item.description, item.bodyOverride])

  const commit = (patch: { title?: string; description?: string; bodyOverride?: string }) => {
    void editQueued(item.id, patch)
  }

  return (
    <div className="border-t border-[var(--color-line)] first:border-t-0">
      {/* Header row — always visible */}
      <div className="flex items-center gap-2 py-1.5">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="t-ghost text-[10px] hover:text-[color:var(--color-mid)]"
          title={expanded ? 'Collapse' : 'Expand to edit'}
          style={{ width: 14 }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span style={{ color: KIND_TONE[item.kind], fontSize: 10 }}>●</span>
        <span
          className="text-[10px] tracking-[0.1em] uppercase shrink-0"
          style={{ color: KIND_TONE[item.kind], width: 70 }}
        >
          {item.kind}
        </span>
        <div className="flex-1 min-w-0">
          <div className="t-mid text-[11px] truncate">{item.title}</div>
          {item.description && !expanded && (
            <div className="t-ghost text-[10px] truncate">{item.description}</div>
          )}
        </div>
        {item.bodyOverride && (
          <span
            className="t-amber text-[9px] uppercase tracking-[0.1em] shrink-0"
            title="Custom body — overrides the auto-generated functional prose"
          >
            edited
          </span>
        )}
        <span className="t-ghost text-[10px] shrink-0 tabular-nums">
          {formatRelative(item.queuedAt)}
        </span>
        <button
          onClick={() => void unqueue(item.id)}
          className="btn text-[10px] hover:!text-[color:var(--color-rose)]"
          title="Remove from queue"
        >
          ×
        </button>
      </div>

      {/* Expanded editor */}
      {expanded && (
        <div className="pl-7 pr-2 pb-2 flex flex-col gap-1.5">
          <Field label="title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title !== item.title && commit({ title })}
              className="w-full bg-transparent outline-none px-2 py-1 text-[11px] t-mid"
              style={{ border: '1px solid var(--color-line)' }}
            />
          </Field>
          <Field
            label="description"
            hint="One-liner shown in queue + carried into the published memory's frontmatter."
          >
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => description !== (item.description ?? '') && commit({ description })}
              className="w-full bg-transparent outline-none px-2 py-1 text-[11px] t-mid"
              style={{ border: '1px solid var(--color-line)' }}
            />
          </Field>
          <Field
            label="functional body"
            hint="What another Claude should know to use or set this up. Leave empty for the auto-generated draft; fill in to override."
          >
            <textarea
              value={bodyOverride}
              onChange={(e) => setBodyOverride(e.target.value)}
              onBlur={() =>
                bodyOverride !== (item.bodyOverride ?? '') && commit({ bodyOverride })
              }
              placeholder="(auto-generated when blank)"
              rows={Math.max(4, Math.min(16, bodyOverride.split('\n').length + 1))}
              className="w-full bg-transparent outline-none px-2 py-1 text-[11px] t-mid font-mono resize-none"
              style={{ border: '1px solid var(--color-line)' }}
            />
          </Field>
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="t-ghost text-[9px] tracking-[0.2em] uppercase block mb-0.5">{label}</label>
      {children}
      {hint && <div className="t-ghost text-[9px] mt-0.5 italic">{hint}</div>}
    </div>
  )
}

function StatusDot({ tone }: { tone: 'phos' | 'warn' | 'dim' }) {
  const color =
    tone === 'phos' ? 'var(--color-phos)' : tone === 'warn' ? 'var(--color-warn)' : 'var(--color-dim)'
  return (
    <span
      className={tone === 'phos' ? 'pulse-phos' : ''}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        boxShadow: tone === 'phos' ? `0 0 6px ${color}` : 'none',
        flexShrink: 0,
      }}
    />
  )
}
