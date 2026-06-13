#!/usr/bin/env tsx
/**
 * renderResumeHead — the resume-and-stop control fix (ratified
 * [[cortex-resume-ux-and-parallelism-design]]).
 *
 * The control bug: /cortex-continue's body told a fresh resume session to "read
 * the linked docs, then continue that work" — so it AUTO-EXECUTED the thread's
 * next_step and ran ~4 min unattended. A resume must re-orient the human and
 * STOP; the next_step is a note FOR the human, not a command the session runs.
 *
 * The defense lives in CODE, not just editable command-body prose: the CLI's
 * resume output itself carries the STOP guard and prints only the HEAD
 * (status + next_step + the LIST of link slugs, NOT their contents). This test
 * pins that contract.
 */
import assert from 'node:assert/strict'
import { renderResumeHead } from '../../bin/_resume-head.ts'

const FULL = {
  id: 'thread:cortex-memory-build',
  description: 'the resume-surface build thread',
  state: {
    status: 'in-progress',
    nextStep: 'Build the resume-UX control fix',
    links: ['cortex-memory-one-mind-use-case', 'cortex-s2-build-state'],
    repo: 'claude-config-dashboard',
    branch: 'master',
    pushed: true,
  },
}

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. the head carries the orienting fields
{
  const out = renderResumeHead(FULL, 'claimed-mine')
  assert.match(out, /RESUMED thread:cortex-memory-build \(claimed-mine\)/, 'RESUMED line w/ id + claim state')
  assert.match(out, /status:\s+in-progress/, 'status line')
  assert.match(out, /next_step:\s+Build the resume-UX control fix/, 'next_step line')
  assert.match(out, /summary:\s+the resume-surface build thread/, 'summary line')
  assert.match(out, /repo:\s+claude-config-dashboard.*branch: master.*pushed: yes/, 'repo/branch/pushed line')
  ok('renders the orienting head fields')
}

// ── 2. links are the SLUG LIST, never their contents
{
  const out = renderResumeHead(FULL, 'claimed-mine')
  assert.match(out, /links:\s+cortex-memory-one-mind-use-case, cortex-s2-build-state/, 'links line is the joined slug list')
  ok('links render as a slug list, not file contents')
}

// ── 3. the STOP guard is code-enforced (the core control fix)
{
  const out = renderResumeHead(FULL, 'claimed-mine')
  assert.match(out, /STOP/, 'output tells the operator to STOP')
  assert.match(out, /do NOT auto-run|not a command/i, 'explicitly forbids auto-running next_step')
  assert.match(out, /keep going/i, 'offers the "keep going" depth path')
  assert.match(out, /how did we get here/i, 'offers the back-story depth path')
  ok('STOP guard + intent-driven depth hints are present')
}

// ── 4. optional lines are omitted when absent; next_step has a fallback
{
  const bare = {
    id: 'thread:bare',
    description: 'no extras',
    state: { status: 'open', nextStep: '', links: [] as string[] },
  }
  const out = renderResumeHead(bare, 'pending')
  assert.ok(!/links:/.test(out), 'no links line when there are no links')
  assert.ok(!/repo:/.test(out), 'no repo line when no repo')
  assert.match(out, /next_step:\s+\(none recorded\)/, 'next_step fallback when empty')
  ok('omits empty optional lines; falls back on missing next_step')
}

console.log(`\nOK resume-head.test.ts — ${passed} assertions passed`)
