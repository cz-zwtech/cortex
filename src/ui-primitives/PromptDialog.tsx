import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

interface PromptRequest {
  title: string
  placeholder?: string
  initialValue?: string
  resolve: (v: string | null) => void
}

interface PromptStore {
  current: PromptRequest | null
  open: (r: Omit<PromptRequest, 'resolve'>) => Promise<string | null>
  close: (v: string | null) => void
}

const usePromptStore = create<PromptStore>((set, get) => ({
  current: null,
  open: (r) =>
    new Promise((resolve) => {
      set({ current: { ...r, resolve } })
    }),
  close: (v) => {
    const r = get().current
    if (r) r.resolve(v)
    set({ current: null })
  },
}))

export const prompt = (title: string, opts?: { placeholder?: string; initialValue?: string }) =>
  usePromptStore.getState().open({ title, ...opts })

export function PromptHost() {
  const current = usePromptStore((s) => s.current)
  const close = usePromptStore((s) => s.close)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setValue(current?.initialValue ?? '')
    if (current) setTimeout(() => inputRef.current?.focus(), 0)
  }, [current])

  if (!current) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[20vh]"
      onClick={() => close(null)}
    >
      <div
        className="w-[420px] max-w-[90vw] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 text-sm">{current.title}</div>
        <div className="p-4">
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') close(value)
              if (e.key === 'Escape') close(null)
            }}
            placeholder={current.placeholder}
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 outline-none focus:border-orange-400"
          />
        </div>
        <div className="px-4 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button
            onClick={() => close(null)}
            className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100"
          >
            Cancel
          </button>
          <button
            onClick={() => close(value)}
            className="px-3 py-1.5 text-sm bg-orange-500 text-zinc-950 rounded hover:bg-orange-400"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
