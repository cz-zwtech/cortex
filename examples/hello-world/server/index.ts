/**
 * The smallest complete module.
 *
 * Note what is NOT here: no imports of core internals, no database, no other
 * module. It declares `storage` nowhere, so `ctx.db` is undefined and the
 * scaffold never opens a database on its behalf — which is what makes the
 * "zero overhead when unused" claim checkable rather than asserted.
 */

import type { CortexModule, ModuleCtx } from '../../../core/ctx.js'

const mod: CortexModule = {
  start(ctx: ModuleCtx) {
    ctx.log(`hello from ${ctx.name} (core ${ctx.core.version}, contract ${ctx.core.contract})`)

    // Capabilities are namespaced to the declaring module and must match what
    // the manifest promised in `provides` — core validates that at parse time.
    ctx.capabilities.provide('hello-world.greet', (who = 'world') => `hello, ${who}`)

    // An optional peer, demonstrated properly: ask, and carry on if absent.
    // There is no throwing variant of get() on purpose.
    const recall = ctx.capabilities.get('memory.recall')
    ctx.log(recall ? 'memory is installed — could enrich' : 'memory absent — running plain')
  },

  stop(ctx: ModuleCtx) {
    ctx.log('stopping')
  },
}

export default mod
