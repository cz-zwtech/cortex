import { Skill, emptySkill } from '@/ontology'
import { Field, InlineTags, InlineText, ProseEditor } from '@/ui-primitives'
import type { UiDescriptor } from './types'
import { KNOWN_TOOLS } from './knowledge'

export const skillDescriptor: UiDescriptor<Skill> = {
  kind: 'skill',
  newLabel: 'New Skill',
  newPromptLabel: 'Skill name',
  newDefault: (name) => emptySkill(name),
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
      <Field label="License">
        <InlineText
          value={value.license ?? ''}
          onChange={(v) => onChange({ ...value, license: v || undefined })}
        />
      </Field>
      <Field label="Allowed tools">
        <InlineTags
          value={value.allowedTools}
          onChange={(v) => onChange({ ...value, allowedTools: v })}
          suggestions={KNOWN_TOOLS}
        />
      </Field>
      <Field label="Body">
        <ProseEditor
          value={value.body}
          onChange={(v) => onChange({ ...value, body: v })}
          minHeight="320px"
        />
      </Field>
    </>
  ),
}
