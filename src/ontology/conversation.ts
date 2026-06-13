import { z } from 'zod'

export const Conversation = z.object({
  sessionId: z.string(),
  title: z.string(),
  startTime: z.string(),
  lastTime: z.string(),
  turnCount: z.number(),
  tokenCount: z.number().optional(),
  projectDir: z.string(),
  filePath: z.string(),
})
export type Conversation = z.infer<typeof Conversation>
