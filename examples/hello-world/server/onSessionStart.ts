/**
 * A lifecycle subscriber.
 *
 * This module registers NO harness hook. Core owns exactly one registration per
 * lifecycle event and dispatches in-process to whoever subscribed — so
 * installing this module does not touch the user's settings.json at all.
 */

export default (payload: unknown): { module: string; saw: unknown } => ({
  module: 'hello-world',
  saw: payload,
})
