import { Rule, emptyRule } from '@/ontology'
import { Field, InlineTags, InlineText, ProseEditor } from '@/ui-primitives'
import type { UiDescriptor } from './types'

export const ruleDescriptor: UiDescriptor<Rule> = {
  kind: 'rule',
  newLabel: 'New Rule',
  newPromptLabel: 'Rule name (use / for nesting)',
  newDefault: (input) => {
    const segs = input.split('/')
    const name = segs.pop() ?? 'rule'
    return { ...emptyRule(name), path: segs.join('/') }
  },
  listLabel: (v) => (v.path ? `${v.path}/${v.name}` : v.name),
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
      <Field label="Applies to paths" hint="Glob patterns, one per entry">
        <InlineTags
          value={value.paths}
          onChange={(v) => onChange({ ...value, paths: v })}
          placeholder="e.g. src/**/*.ts"
        />
      </Field>
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
