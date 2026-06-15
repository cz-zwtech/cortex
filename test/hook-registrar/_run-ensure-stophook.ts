#!/usr/bin/env tsx
/**
 * Helper for ephemeral-boot-no-register.test.ts. Runs the EXACT boot-time
 * registration call (server/index.ts does `await ensureStopHook()`), then exits.
 * The parent supplies HOME + the gate flags via env, so each spawn is a fresh
 * process whose os.homedir()-derived paths land under the parent's temp HOME.
 * Underscore-prefixed so a test glob does not pick it up as a test.
 */
import { ensureStopHook } from '../../server/hookRegistrar.js'

await ensureStopHook()
process.exit(0)
