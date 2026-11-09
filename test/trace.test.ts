/**
 * The hook trace exists because six of seven lifecycle events were UNPROVABLE.
 * These tests guard the properties that make it evidence rather than decoration.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readTrace, trace, traceEnabled, traceFile, traceSummary } from '../core/trace.js'

const withStateDir = async (fn: () => void | Promise<void>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-trace-'))
  const prevState = process.env.CKN_STATE_DIR
  const prevOff = process.env.CORTEX_TRACE
  process.env.CKN_STATE_DIR = dir
  delete process.env.CORTEX_TRACE
  try {
    await fn()
  } finally {
    if (prevState === undefined) delete process.env.CKN_STATE_DIR
    else process.env.CKN_STATE_DIR = prevState
    if (prevOff === undefined) delete process.env.CORTEX_TRACE
    else process.env.CORTEX_TRACE = prevOff
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const entry = (event: string, over: Partial<Parameters<typeof trace>[0]> = {}) => ({
  event,
  at: '2026-08-08T00:00:00.000Z',
  subscribers: 0,
  durationMs: 1,
  modules: 0,
  ...over,
})

test('a hook with ZERO subscribers still leaves evidence', async () => {
  // The whole reason this exists. With no modules installed, a hook that fired
  // and a hook that never ran used to produce byte-identical evidence — and the
  // naked scaffold is a configuration core explicitly claims to support.
  await withStateDir(() => {
    trace(entry('SessionStart'))
    const got = readTrace()
    assert.equal(got.length, 1)
    assert.equal(got[0]!.subscribers, 0, 'zero is a legitimate, informative value')
    assert.equal(got[0]!.modules, 0)
  })
})

test('tracing is ON by default — opt out, never opt in', async () => {
  // A default-off diagnostic is absent exactly when the incident happens.
  await withStateDir(() => {
    assert.equal(traceEnabled(), true)
    process.env.CORTEX_TRACE = 'off'
    assert.equal(traceEnabled(), false)
    trace(entry('SessionStart'))
    assert.deepEqual(readTrace(), [], 'and off really means nothing is written')
  })
})

test('a trace failure NEVER throws', async () => {
  // The dispatcher's standing rule is that nothing can break the user's
  // session. A diagnostic that can crash the thing it observes is worse than
  // no diagnostic.
  //
  // The unwritable path here is a FILE used as a directory, which fails fast.
  // An earlier revision used a path under /proc, and `mkdirSync` HUNG on it
  // rather than failing — which is how the trace's own hang risk was found.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-trace-bad-'))
  const notADir = path.join(dir, 'file')
  await fs.writeFile(notADir, 'x')
  const prev = process.env.CKN_STATE_DIR
  process.env.CKN_STATE_DIR = notADir
  try {
    assert.doesNotThrow(() => trace(entry('SessionStart')))
  } finally {
    if (prev === undefined) delete process.env.CKN_STATE_DIR
    else process.env.CKN_STATE_DIR = prev
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the summary reports which events have been seen and which have not', async () => {
  await withStateDir(() => {
    trace(entry('SessionStart'))
    trace(entry('Stop'))
    trace(entry('Stop', { at: '2026-08-08T00:00:05.000Z' }))

    const s = traceSummary()
    assert.equal(s.Stop!.count, 2)
    assert.equal(s.Stop!.last, '2026-08-08T00:00:05.000Z', 'last wins')
    assert.equal(s.SessionStart!.count, 1)
    assert.equal(s.UserPromptSubmit, undefined, 'unseen events are absent, not zero')
  })
})

test('a corrupt line does not make the whole trace unreadable', async () => {
  await withStateDir(async () => {
    trace(entry('SessionStart'))
    await fs.appendFile(traceFile(), '{not json\n')
    trace(entry('Stop'))

    assert.deepEqual(
      readTrace().map((e) => e.event),
      ['SessionStart', 'Stop'],
      'salvages what it can',
    )
  })
})

test('failures are recorded by module', async () => {
  await withStateDir(() => {
    trace(entry('Stop', { subscribers: 2, failures: ['memory'] }))
    assert.deepEqual(readTrace()[0]!.failures, ['memory'])
  })
})

test('an entry carrying a harness session id is corroborable; one without says so', async () => {
  // The circularity objection, answered structurally. A dispatcher writing its
  // own trace proves only that the dispatcher ran — I proved that myself by
  // firing all seven events from a shell, and the entries were indistinguishable
  // from a real session's. A session id is minted by the harness and names a
  // transcript file Cortex never writes, so it corroborates from outside.
  await withStateDir(() => {
    trace(entry('SessionStart', { session: 'abc-123' }))
    trace(entry('SessionStart'))

    const got = readTrace()
    assert.equal(got[0]!.session, 'abc-123', 'harness-invoked')
    assert.equal(got[1]!.session, undefined, 'invoked by something that is not the harness')
  })
})
