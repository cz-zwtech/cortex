#!/usr/bin/env tsx
/**
 * ckn-update planUpdate() — the pure per-node update decision. Encodes the 3 fleet
 * shapes via the (lifecycle -> restart) mapping (zw1 systemd, zwd/laptop process),
 * the offline CLEAN no-op (the laptop case — origin unreachable never half-applies),
 * and the refuse-clean guards (dirty / diverged) so a node never lands half-applied.
 */
import assert from 'node:assert/strict'

const { planUpdate } = await import('../bin/ckn-update.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const base = {
  originReachable: true,
  originIsGithub: true,
  behind: 1,
  dirty: false,
  ffable: true,
  lifecycle: 'process' as 'process' | 'systemd',
  noRestart: false,
  depsChanged: false,
}

// ── offline → CLEAN no-op (laptop), regardless of behind/dirty ──────────────
{
  const r = planUpdate({ ...base, originReachable: false, behind: 5, dirty: true })
  assert.equal(r.action, 'noop-offline')
  assert.equal(r.restart, 'none')
  ok('origin unreachable → clean no-op (never half-applies), no restart')
}

// ── not-yet-repointed (origin != github), clean → repoint + lifecycle restart ─
{
  const r = planUpdate({ ...base, originIsGithub: false, lifecycle: 'systemd' })
  assert.equal(r.action, 'repoint')
  assert.equal(r.restart, 'systemd')
  ok('origin!=github + clean → repoint + systemd restart')
}

// ── not-yet-repointed but DIRTY → refuse (no half-apply) ────────────────────
{
  const r = planUpdate({ ...base, originIsGithub: false, dirty: true })
  assert.equal(r.action, 'refuse-dirty')
  assert.equal(r.restart, 'none')
  ok('origin!=github + dirty → refuse-dirty')
}

// ── already github, up-to-date → no-op ──────────────────────────────────────
{
  const r = planUpdate({ ...base, behind: 0 })
  assert.equal(r.action, 'up-to-date')
  assert.equal(r.restart, 'none')
  ok('github + behind 0 → up-to-date no-op')
}

// ── github, behind, dirty → refuse-dirty ────────────────────────────────────
{
  const r = planUpdate({ ...base, behind: 2, dirty: true })
  assert.equal(r.action, 'refuse-dirty')
  assert.equal(r.restart, 'none')
  ok('github + behind + dirty → refuse-dirty')
}

// ── github, behind, clean, NOT ff-able → refuse-diverged ────────────────────
{
  const r = planUpdate({ ...base, behind: 2, ffable: false })
  assert.equal(r.action, 'refuse-diverged')
  assert.equal(r.restart, 'none')
  ok('github + diverged (not ff) → refuse-diverged')
}

// ── github, apply, process lifecycle → reboot ───────────────────────────────
{
  const r = planUpdate({ ...base, behind: 3, lifecycle: 'process' })
  assert.equal(r.action, 'apply')
  assert.equal(r.restart, 'reboot')
  ok('github + apply + process lifecycle → reboot')
}

// ── github, apply, systemd lifecycle → systemd ──────────────────────────────
{
  const r = planUpdate({ ...base, behind: 3, lifecycle: 'systemd' })
  assert.equal(r.action, 'apply')
  assert.equal(r.restart, 'systemd')
  ok('github + apply + systemd lifecycle → systemd restart')
}

// ── apply + --no-restart → pull only (no restart) ───────────────────────────
{
  const r = planUpdate({ ...base, behind: 3, noRestart: true })
  assert.equal(r.action, 'apply')
  assert.equal(r.restart, 'none')
  ok('apply + --no-restart → no restart')
}

// ── repoint + --no-restart → no restart (defer to power-cycle) ───────────────
{
  const r = planUpdate({ ...base, originIsGithub: false, noRestart: true })
  assert.equal(r.action, 'repoint')
  assert.equal(r.restart, 'none')
  ok('repoint + --no-restart → no restart')
}

// ── deps changed (package.json) → npm ci required in a DOWN window ───────────
// systemd can ci in-band (stop→ci→start); the shared non-systemd box can't slot a ci
// inside ckn-reboot's announce window, so it applies but refuses the auto-restart.

// systemd + apply + depsChanged → npmCi, restart stays systemd
{
  const r = planUpdate({ ...base, behind: 2, lifecycle: 'systemd', depsChanged: true })
  assert.equal(r.action, 'apply')
  assert.equal(r.restart, 'systemd')
  assert.equal(r.npmCi, true)
  ok('systemd + apply + depsChanged → npmCi, restart systemd (stop→ci→start)')
}

// process + apply + depsChanged → refuse auto-restart (restart none), npmCi flagged
{
  const r = planUpdate({ ...base, behind: 2, lifecycle: 'process', depsChanged: true })
  assert.equal(r.action, 'apply')
  assert.equal(r.restart, 'none')
  assert.equal(r.npmCi, true)
  assert.match(r.message, /NOT auto-restarting/)
  ok('process + apply + depsChanged → refuse auto-restart (none), npmCi flagged')
}

// systemd + repoint + depsChanged → npmCi, restart systemd
{
  const r = planUpdate({ ...base, originIsGithub: false, lifecycle: 'systemd', depsChanged: true })
  assert.equal(r.action, 'repoint')
  assert.equal(r.restart, 'systemd')
  assert.equal(r.npmCi, true)
  ok('systemd + repoint + depsChanged → npmCi, restart systemd')
}

// apply + depsChanged + --no-restart → npmCi flagged for the next boot, restart none
{
  const r = planUpdate({ ...base, behind: 2, depsChanged: true, noRestart: true })
  assert.equal(r.action, 'apply')
  assert.equal(r.restart, 'none')
  assert.equal(r.npmCi, true)
  ok('apply + depsChanged + --no-restart → npmCi flagged, restart none')
}

// no deps change → npmCi false (regression guard against false positives)
{
  const r = planUpdate({ ...base, behind: 2, lifecycle: 'systemd' })
  assert.equal(r.action, 'apply')
  assert.equal(r.restart, 'systemd')
  assert.equal(r.npmCi, false)
  ok('apply without deps change → npmCi false, plain restart')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
