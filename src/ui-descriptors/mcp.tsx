import { McpServer, emptyMcpServer, type McpTransport } from '@/ontology'
import {
  ArrayEditor,
  Field,
  InlineSelect,
  InlineText,
  KeyValueEditor,
} from '@/ui-primitives'
import type { UiDescriptor } from './types'
import { MCP_TRANSPORTS } from './knowledge'

export const mcpDescriptor: UiDescriptor<McpServer> = {
  kind: 'mcp',
  newLabel: 'New MCP Server',
  newPromptLabel: 'Server name',
  newDefault: (name) => emptyMcpServer(name),
  listLabel: (v) => v.name,
  listSublabel: (v) => v.command || v.url || '(unconfigured)',
  Editor: ({ value, onChange }) => (
    <>
      <Field label="Name">
        <InlineText
          value={value.name}
          onChange={(v) => onChange({ ...value, name: v })}
          monospace
        />
      </Field>
      <Field label="Transport">
        <InlineSelect
          value={value.type}
          options={MCP_TRANSPORTS}
          onChange={(v) => onChange({ ...value, type: (v ?? 'stdio') as McpTransport })}
        />
      </Field>
      {value.type === 'stdio' && (
        <>
          <Field label="Command">
            <InlineText
              value={value.command}
              onChange={(v) => onChange({ ...value, command: v })}
              monospace
              placeholder="e.g. npx"
            />
          </Field>
          <Field label="Args">
            <ArrayEditor
              value={value.args}
              onChange={(v) => onChange({ ...value, args: v })}
              monospace
              placeholder="argument"
            />
          </Field>
        </>
      )}
      {(value.type === 'sse' || value.type === 'http') && (
        <Field label="URL">
          <InlineText
            value={value.url ?? ''}
            onChange={(v) => onChange({ ...value, url: v })}
            monospace
            placeholder="https://…"
          />
        </Field>
      )}
      <Field label="Environment">
        <KeyValueEditor
          value={value.env}
          onChange={(v) => onChange({ ...value, env: v })}
        />
      </Field>
    </>
  ),
}
