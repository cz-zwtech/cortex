import {
  Permission,
  PermissionModes,
  emptyPermission,
  parsePermission,
  describeTool,
  type PermissionMode,
} from '@/ontology'
import { Field, InlineSelect, InlineText } from '@/ui-primitives'
import type { UiDescriptor } from './types'
import { KNOWN_TOOLS } from './knowledge'

const MODE_OPTIONS = PermissionModes.map((m) => ({ value: m, label: m }))

const MODE_TONE: Record<PermissionMode, string> = {
  allow: 'var(--color-phos)',
  deny: 'var(--color-rose)',
  ask: 'var(--color-warn)',
}

export const permissionDescriptor: UiDescriptor<Permission> = {
  kind: 'permission',
  newLabel: 'New Permission',
  newPromptLabel: 'Rule (e.g. "Bash(npm install *)") — leave blank to fill in later',
  newDefault: (input) => ({
    ...emptyPermission('allow'),
    pattern: (input ?? '').trim(),
  }),
  listLabel: (v) => v.pattern || `(empty ${v.mode})`,
  listSublabel: (v) => v.mode,
  tabs: [
    { id: 'all', label: 'All', predicate: () => true },
    { id: 'allow', label: 'Allow', predicate: (v) => v.mode === 'allow' },
    { id: 'deny', label: 'Deny', predicate: (v) => v.mode === 'deny' },
    { id: 'ask', label: 'Ask', predicate: (v) => v.mode === 'ask' },
  ],
  Editor: ({ value, onChange }) => {
    const { tool, argSpec } = parsePermission(value.pattern)
    const description = describeTool(tool)
    const tone = MODE_TONE[value.mode]
    return (
      <>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Mode" hint="allow runs without prompting · deny blocks the call · ask prompts the user every time.">
            <InlineSelect
              value={value.mode}
              options={MODE_OPTIONS}
              onChange={(v) =>
                onChange({ ...value, mode: (v as PermissionMode) ?? 'allow' })
              }
            />
          </Field>
          <Field
            label="Mode marker"
            hint="Visual reminder of the rule's effect."
          >
            <span
              className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] tracking-[0.15em] uppercase border"
              style={{ color: tone, borderColor: tone, borderRadius: 0 }}
            >
              <span>●</span>
              {value.mode}
            </span>
          </Field>
        </div>

        <Field
          label="Pattern"
          hint="Format: Tool(argument-glob). Examples: Bash(npm install *), Read(/home/user/**), Edit(*.ts)."
        >
          <InlineText
            value={value.pattern}
            onChange={(v) => onChange({ ...value, pattern: v })}
            placeholder="Bash(git status *)"
            monospace
          />
        </Field>

        {/* Parsed preview */}
        <div
          className="grid grid-cols-2 gap-4"
          style={{ marginTop: 4 }}
        >
          <Field label="Tool">
            <div
              className="font-mono text-[12px]"
              style={{ color: tool ? 'var(--color-pale)' : 'var(--color-ghost)' }}
            >
              {tool || '— (rule has no Tool() prefix)'}
            </div>
          </Field>
          <Field label="Argument">
            <div
              className="font-mono text-[12px] truncate"
              style={{ color: argSpec ? 'var(--color-mid)' : 'var(--color-ghost)' }}
              title={argSpec}
            >
              {argSpec || '(none — full tool, any args)'}
            </div>
          </Field>
        </div>

        {tool && (
          <Field label={`About ${tool}`}>
            <div
              className="text-[12px] leading-[1.55] p-3"
              style={{
                background: 'var(--color-bg-2)',
                border: '1px solid var(--color-line)',
                color: 'var(--color-mid)',
              }}
            >
              {description}
            </div>
          </Field>
        )}

        {/* Quick reference for built-in tools — purely informational. */}
        <Field label="Built-in tools">
          <div className="flex flex-wrap gap-1.5">
            {KNOWN_TOOLS.map((t) => {
              const active = t === tool
              return (
                <button
                  key={t}
                  onClick={() => {
                    // Replace the tool name while preserving the existing arg spec.
                    const arg = argSpec || '*'
                    onChange({ ...value, pattern: `${t}(${arg})` })
                  }}
                  className="tag"
                  style={{
                    fontSize: 10,
                    cursor: 'pointer',
                    borderColor: active ? 'var(--color-amber-dim)' : 'var(--color-line)',
                    color: active ? 'var(--color-amber)' : 'var(--color-dim)',
                  }}
                  title={describeTool(t)}
                  type="button"
                >
                  {t}
                </button>
              )
            })}
          </div>
        </Field>
      </>
    )
  },
}
