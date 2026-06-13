import { z } from 'zod'

export const McpTransport = z.enum(['stdio', 'sse', 'http'])
export type McpTransport = z.infer<typeof McpTransport>

export const McpServer = z.object({
  name: z.string().min(1),
  type: McpTransport.default('stdio'),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().optional(),
  enabled: z.boolean().default(true),
})
export type McpServer = z.infer<typeof McpServer>

export const emptyMcpServer = (name: string): McpServer => ({
  name,
  type: 'stdio',
  command: '',
  args: [],
  env: {},
  enabled: true,
})
