/** SessionEnd: the catch-up captures the rest of this session's transcript after the CLI exits. */
import type { ModuleCtx } from '../../../core/ctx.js'
import { spawnCatchUp } from './context/hooks.js'

export default (_payload: unknown, ctx: ModuleCtx) => {
  spawnCatchUp(ctx, 'session-end')
  return undefined
}
