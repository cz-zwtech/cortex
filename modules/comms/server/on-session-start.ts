/** SessionStart: settle identity, pin the title, show what waited while away. */
import type { ModuleCtx } from '../../../core/ctx.js'
import { handle } from './hooks.js'

export default (payload: unknown, ctx: ModuleCtx) => handle(payload, ctx, 'SessionStart')
