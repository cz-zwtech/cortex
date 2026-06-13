import { Hook, emptyHook, type HookEvent, type HookHandler } from '@/ontology'
import { Field, InlineSelect, InlineText } from '@/ui-primitives'
import type { UiDescriptor } from './types'
import { HOOK_EVENTS } from './knowledge'

export const hookDescriptor: UiDescriptor<Hook> = {
  kind: 'hook',
  newLabel: 'New Hook',
  newPromptLabel: 'Hook event (e.g. PreToolUse)',
  newDefault: (input) => {
    const event = (HOOK_EVENTS.find((e) => e.value === input)?.value ??
      'PreToolUse') as HookEvent
    return emptyHook(event)
  },
  listLabel: (v) => v.event,
  listSublabel: (v) => (v.matcher ? `matcher: ${v.matcher}` : '(any)'),
  Editor: ({ value, onChange }) => {
    const setHandler = (i: number, h: Partial<HookHandler>) => {
      const next = value.handlers.slice()
      next[i] = { ...next[i]!, ...h }
      onChange({ ...value, handlers: next })
    }
    const addHandler = () =>
      onChange({
        ...value,
        handlers: [...value.handlers, { type: 'command', command: '' }],
      })
    const removeHandler = (i: number) =>
      onChange({ ...value, handlers: value.handlers.filter((_, idx) => idx !== i) })
    return (
      <>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Event">
            <InlineSelect
              value={value.event}
              options={HOOK_EVENTS}
              onChange={(v) => onChange({ ...value, event: v as HookEvent })}
            />
          </Field>
          <Field label="Matcher" hint="Tool name pattern. Leave blank to match all.">
            <InlineText
              value={value.matcher}
              onChange={(v) => onChange({ ...value, matcher: v })}
              placeholder="e.g. Bash"
              monospace
            />
          </Field>
        </div>
        <Field label="Handlers">
          <div className="space-y-3">
            {value.handlers.map((h, i) => (
              <div key={i} className="rounded border border-zinc-800 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Handler {i + 1}</span>
                  <button
                    onClick={() => removeHandler(i)}
                    className="text-xs text-zinc-500 hover:text-red-400"
                  >
                    remove
                  </button>
                </div>
                <Field label="Command">
                  <InlineText
                    value={h.command}
                    onChange={(v) => setHandler(i, { command: v })}
                    monospace
                  />
                </Field>
                <Field label="Timeout (seconds)">
                  <InlineText
                    value={h.timeout?.toString() ?? ''}
                    onChange={(v) => {
                      const n = parseInt(v, 10)
                      setHandler(i, { timeout: Number.isFinite(n) ? n : undefined })
                    }}
                    placeholder="no timeout"
                    monospace
                  />
                </Field>
              </div>
            ))}
            <button
              onClick={addHandler}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              + add handler
            </button>
          </div>
        </Field>
      </>
    )
  },
}
