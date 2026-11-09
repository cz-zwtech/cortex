/**
 * SessionEnd — capture what this session wrote, on the larger budget.
 *
 * Nobody is waiting here, so this is the sweep that should normally finish.
 * SessionStart is the safety net for the sessions that never reach it.
 */
import { onSessionEnd } from './on-session.js'
export default onSessionEnd
