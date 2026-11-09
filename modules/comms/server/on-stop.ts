/** Stop: hold the turn open while this member has no live watcher. */
import type { ModuleCtx } from '../../../core/ctx.js'
import { handleStop } from './hooks.js'

export default (payload: unknown, ctx: ModuleCtx) => handleStop(payload, ctx)
