/** Stop: hold the turn open when this member was told its watcher is down and did not re-arm. */
import type { ModuleCtx } from '../../../core/ctx.js'
import { handleStop } from './hooks.js'

export default (payload: unknown, ctx: ModuleCtx) => handleStop(payload, ctx)
