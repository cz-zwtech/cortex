/** UserPromptSubmit: beat, deliver new messages, and pin the title after a mid-session join. */
import type { ModuleCtx } from '../../../core/ctx.js'
import { handle } from './hooks.js'

export default (payload: unknown, ctx: ModuleCtx) => handle(payload, ctx, 'UserPromptSubmit')
