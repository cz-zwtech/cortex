import { Agent, emptyAgent } from '@/ontology'
import {
  Field,
  InlineSelect,
  InlineTags,
  InlineText,
  ProseEditor,
} from '@/ui-primitives'
import type { UiDescriptor } from './types'
import { AGENT_COLORS, KNOWN_TOOLS, MODEL_OPTIONS } from './knowledge'

export const agentDescriptor: UiDescriptor<Agent> = {
  kind: 'agent',
  newLabel: 'New Agent',
  newPromptLabel: 'Agent name',
  newDefault: (name) => emptyAgent(name),
  listLabel: (v) => v.name,
  listSublabel: (v) => v.description,
  Editor: ({ value, onChange }) => (
    <>
      <Field label="Name">
        <InlineText value={value.name} onChange={(v) => onChange({ ...value, name: v })} />
      </Field>
      <Field label="Description">
        <InlineText
          value={value.description}
          onChange={(v) => onChange({ ...value, description: v })}
          multiline
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Model">
          <InlineSelect
            value={value.model}
            options={MODEL_OPTIONS}
            onChange={(v) => onChange({ ...value, model: v as Agent['model'] })}
            placeholder="inherit"
            allowEmpty
          />
        </Field>
        <Field label="Color">
          <InlineSelect
            value={value.color}
            options={AGENT_COLORS}
            onChange={(v) => onChange({ ...value, color: v })}
            placeholder="none"
            allowEmpty
          />
        </Field>
      </div>
      <Field label="Tools">
        <InlineTags
          value={value.tools}
          onChange={(v) => onChange({ ...value, tools: v })}
          placeholder="Add tool…"
          suggestions={KNOWN_TOOLS}
        />
      </Field>
      <Field label="Prompt">
        <ProseEditor
          value={value.body}
          onChange={(v) => onChange({ ...value, body: v })}
          minHeight="280px"
        />
      </Field>
    </>
  ),
}
