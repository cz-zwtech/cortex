import { ClaudeMd, emptyClaudeMd } from '@/ontology'
import { Field, ProseEditor } from '@/ui-primitives'
import type { UiDescriptor } from './types'

export const claudemdDescriptor: UiDescriptor<ClaudeMd> = {
  kind: 'claudemd',
  newLabel: 'New CLAUDE.md',
  newPromptLabel: 'Relative path (default: CLAUDE.md)',
  newDefault: (input) => emptyClaudeMd(input.trim() || 'CLAUDE.md'),
  listLabel: (v) => v.relPath,
  listSublabel: (v) =>
    v.body.split('\n').find((l) => l.trim().length > 0)?.slice(0, 80) ?? '',
  Editor: ({ value, onChange }) => (
    <Field label="Content">
      <ProseEditor
        value={value.body}
        onChange={(v) => onChange({ ...value, body: v })}
        minHeight="460px"
      />
    </Field>
  ),
}
