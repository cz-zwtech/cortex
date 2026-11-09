/**
 * SessionStart — sweep first, on the tighter budget, because a human is waiting.
 *
 * Sweeping at start as well as end is not redundancy: a memory written by a
 * session that never reached SessionEnd would otherwise sit un-ingested
 * indefinitely, and the failure is invisible — recall simply does not return it,
 * which is indistinguishable from it never having been written.
 */
import { onSessionStart } from './on-session.js'
export default onSessionStart
