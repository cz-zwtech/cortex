import { Memory, Rule, emptyMemory, type MemoryType } from '@/ontology'
import { Field, InlineSelect, InlineText, ProseEditor } from '@/ui-primitives'
import type { UiDescriptor } from './types'

const MEMORY_TYPES = [
  { value: 'user', label: 'User — about the user' },
  { value: 'feedback', label: 'Feedback — how to approach work' },
  { value: 'project', label: 'Project — ongoing work context' },
  { value: 'reference', label: 'Reference — pointers to external systems' },
]

const typeBadge = (type: MemoryType): string => {
  switch (type) {
    case 'user':
      return 'about user'
    case 'feedback':
      return 'feedback'
    case 'project':
      return 'project'
    case 'reference':
      return 'reference'
  }
}

export const memoryDescriptor: UiDescriptor<Memory> = {
  kind: 'memory',
  newLabel: 'New Memory',
  newPromptLabel: 'Memory name',
  newDefault: (name) => emptyMemory(name),
  listLabel: (v) => v.name,
  listSublabel: (v) => `${typeBadge(v.type)} · ${v.description}`,
  customActions: (entity, ctx) => [
    {
      label: 'Convert to Rule',
      onSelect: async () => {
        const m = entity.value
        const rule = Rule.parse({
          name: m.name,
          path: '',
          description: m.description,
          body: m.body,
        })
        await ctx.createIn('rule', rule, ctx.scope)
        await ctx.remove(entity)
      },
    },
  ],
  Editor: ({ value, onChange }) => (
    <>
      <Field label="Name">
        <InlineText
          value={value.name}
          onChange={(v) => onChange({ ...value, name: v })}
        />
      </Field>
      <Field label="Type">
        <InlineSelect
          value={value.type}
          options={MEMORY_TYPES}
          onChange={(v) => onChange({ ...value, type: (v ?? 'project') as MemoryType })}
        />
      </Field>
      <Field label="Description" hint="One-line summary — shown in MEMORY.md index">
        <InlineText
          value={value.description}
          onChange={(v) => onChange({ ...value, description: v })}
        />
      </Field>
      <Field label="Content">
        <ProseEditor
          value={value.body}
          onChange={(v) => onChange({ ...value, body: v })}
          minHeight="340px"
        />
      </Field>
    </>
  ),
}
