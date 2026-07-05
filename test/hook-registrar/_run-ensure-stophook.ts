#!/usr/bin/env tsx
/**
 * Helper for ephemeral-boot-no-register.test.ts. Runs the EXACT boot-time
 * registration call (server/index.ts does `await ensureStopHook()`), then exits.
 * The parent supplies HOME + the gate flags via env, so each spawn is a fresh
 * process whose os.homedir()-derived paths land under the parent's temp HOME.
 * Underscore-prefixed so a test glob does not pick it up as a test.
 */
import { ensureStopHook } from '../../server/hookRegistrar.js'

// The #154 canonical gate inspects the install path (a linked worktree never
// registers). This test file lives in a worktree, so the parent can point the
// boot at a synthetic non-worktree projectRoot via CKN_TEST_PROJECT_ROOT to
// exercise the canonical-registers path; unset = the real PROJECT_ROOT.
await ensureStopHook(process.env.CKN_TEST_PROJECT_ROOT || undefined)
process.exit(0)
