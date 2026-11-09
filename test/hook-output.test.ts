/**
 * The dispatcher's EMITTED BYTES, asserted by running the real process.
 *
 * `bin/cortex-hook.ts` is the one file whose behaviour cannot be checked by
 * importing it: what matters is the JSON on stdout, produced by a process the
 * harness starts. Every other test in this repo asserts a return value; this one
 * asserts what actually leaves the building.
 *
 * That distinction has already cost this project three defects — the config dir,
 * the modules dir, and the deny schema all passed in-process checks and failed
 * the first time something we did not control had to read our output.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const REPO = path.resolve(import.meta.dirname, '..')

/** Run the dispatcher for real, in an isolated state dir, and return its stdout. */
const dispatch = async (
  event: string,
  payload: unknown,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-hookout-'))
  try {
    const child = execFile(
      'npx',
      ['tsx', path.join(REPO, 'bin', 'cortex-hook.ts'), event],
      {
        cwd: REPO,
        env: {
          ...process.env,
          CKN_STATE_DIR: state,
          CKN_MODULES_DIR: path.join(state, 'modules'),
          CKN_DB_PATH: path.join(state, 'cortex.sqlite'),
          CORTEX_TRACE: 'off',
          ...env,
        },
      },
    )
    child.stdin?.end(JSON.stringify(payload))
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((res) => {
      let out = ''
      let err = ''
      child.stdout?.on('data', (d) => (out += d))
      child.stderr?.on('data', (d) => (err += d))
      child.on('close', () => res({ stdout: out, stderr: err }))
    })
    return { stdout, stderr }
  } finally {
    await fs.rm(state, { recursive: true, force: true })
  }
}

test('LIVENESS IS OFF BY DEFAULT — no core text reaches the model unasked', async () => {
  // Shipped as it was, every SessionStart injected a nonce tag into the session's
  // context. The content was harmless; the PATH was the problem — core had a
  // private, unbudgeted, always-on write channel into the model's context, and a
  // random nonce arriving every session was proof it was live and unguarded.
  const { stdout } = await dispatch('SessionStart', { session_id: 's1' })
  assert.ok(!stdout.includes('cortex-liveness'), `unexpected injection: ${stdout}`)
})

test('a zero-module scaffold emits NOTHING AT ALL, not an empty object', async () => {
  // An empty JSON object is not the same as silence, and the harness should see
  // silence.
  const { stdout } = await dispatch('SessionStart', { session_id: 's1' })
  assert.equal(stdout.trim(), '')
})

test('with CORTEX_LIVENESS=on the echo appears, on hookSpecificOutput', async () => {
  // Top-level additionalContext was ACCEPTED on SessionStart and SILENTLY
  // IGNORED on UserPromptSubmit — a corroboration route that failed without
  // failing. It has to ride hookSpecificOutput.
  const { stdout } = await dispatch('SessionStart', { session_id: 's1' }, { CORTEX_LIVENESS: 'on' })
  const out = JSON.parse(stdout)
  assert.ok(out.hookSpecificOutput, 'must not be top-level')
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(out.hookSpecificOutput.additionalContext, /cortex-liveness/)
})

test('the echo is a CONTRIBUTION, so UserPromptSubmit gets it the same way', async () => {
  const { stdout } = await dispatch(
    'UserPromptSubmit',
    { session_id: 's1' },
    { CORTEX_LIVENESS: 'on' },
  )
  const out = JSON.parse(stdout)
  assert.match(out.hookSpecificOutput.additionalContext, /cortex-liveness/)
})

test('PreToolUse never carries the echo, even when liveness is on', async () => {
  // It is a context-injection diagnostic; PreToolUse is a decision event.
  const { stdout } = await dispatch(
    'PreToolUse',
    { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } },
    { CORTEX_LIVENESS: 'on' },
  )
  assert.ok(!stdout.includes('cortex-liveness'), stdout)
})

test('THE CANARY DENY IS UNGATED, AND DELIBERATELY SO', async () => {
  // Gating the deny behind a flag would make the refusal path test-only, which
  // is exactly the defect class the liveness work exists to close: a mechanism
  // that only exists under test proves nothing about the one that ships.
  // Denying a command that literally names itself a Cortex UAT canary harms
  // nobody.
  const { stdout } = await dispatch('PreToolUse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'echo cortex-uat-canary' },
  })
  const out = JSON.parse(stdout)
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.ok(
    !('decision' in out),
    'the legacy field is what failed harness validation and ran the tool',
  )
})

test('an unknown event exits 0 and emits nothing — a hook must never break a session', async () => {
  const { stdout } = await dispatch('NotAnEvent', {})
  assert.equal(stdout.trim(), '')
})
