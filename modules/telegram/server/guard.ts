/**
 * Guards that stop a test from touching the live store or sending for real.
 *
 * The earlier gateway learned this the hard way: test runs sent real claim requests to
 * every live session, carrying fixture text with a shell payload in it. So the
 * checks live where the harm happens (opening the store, constructing a real
 * channel, sending over comms), not in test setup, where a forgotten line
 * would bypass them.
 */
import { guardRoot, underTest } from '../../../core/paths.js'

export const assertWritable = (file: string): void => {
  guardRoot(file, 'the telegram store')
}

export const assertCanSend = (what: string): void => {
  if (underTest()) throw new Error(`telegram guard: a test tried to use a live ${what}; inject a fake instead`)
}
