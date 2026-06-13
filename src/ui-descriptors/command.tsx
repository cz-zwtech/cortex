import { Command, emptyCommand } from '@/ontology'
import {
  Field,
  InlineSelect,
  InlineTags,
  InlineText,
  ProseEditor,
} from '@/ui-primitives'
import type { UiDescriptor } from './types'
import { KNOWN_TOOLS, MODEL_OPTIONS } from './knowledge'

export const commandDescriptor: UiDescriptor<Command> = {
  kind: 'command',
  newLabel: 'New Command',
  newPromptLabel: 'Command name (use / for nesting, e.g. "git/commit")',
  newDefault: (input) => {
    const segs = input.split('/')
    const name = segs.pop() ?? 'command'
    return { ...emptyCommand(name), path: segs.join('/') }
  },
  listLabel: (v) => `/${v.path ? `${v.path}/` : ''}${v.name}`,
  listSublabel: (v) => v.description,
  Editor: ({ value, onChange }) => (
    <>
      <Field label="Name">
        <InlineText
          value={value.name}
          onChange={(v) => onChange({ ...value, name: v })}
          monospace
        />
      </Field>
      <Field label="Description">
        <InlineText
          value={value.description}
          onChange={(v) => onChange({ ...value, description: v })}
        />
      </Field>
      <Field label="Argument hint">
        <InlineText
          value={value.argumentHint ?? ''}
          onChange={(v) => onChange({ ...value, argumentHint: v || undefined })}
          placeholder="e.g. <ticket-id>"
          monospace
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Model">
          <InlineSelect
            value={value.model}
            options={MODEL_OPTIONS}
            onChange={(v) => onChange({ ...value, model: v as Command['model'] })}
            placeholder="inherit"
            allowEmpty
          />
        </Field>
        <Field label="Allowed tools">
          <InlineTags
            value={value.allowedTools}
            onChange={(v) => onChange({ ...value, allowedTools: v })}
            suggestions={KNOWN_TOOLS}
          />
        </Field>
      </div>
      <Field label="Body">
        <ProseEditor
          value={value.body}
          onChange={(v) => onChange({ ...value, body: v })}
          minHeight="280px"
        />
      </Field>
    </>
  ),
}
