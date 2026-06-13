#!/usr/bin/env tsx
/**
 * Disk-free-space guard. The 2026-06-09 corrected RCA ([[cortex-node-segfault-
 * coredump-rca]]): the node crashes were SIGBUS (signal 7) = disk-full / mmap
 * fault, environmental — C: filled with WSL core dumps + a daily 5 GB swap.vhdx.
 * Corey decision #3: a disk-free-space guard/alert is the real preventive
 * (monitoring, not embedding code surgery). This is its pure decision logic.
 */
import assert from 'node:assert/strict'
import {
  diskAlertLevel,
  policyFromEnv,
  DEFAULT_DISK_POLICY,
  checkDiskPaths,
} from '../server/diskGuard.js'
import os from 'node:os'

const GB = 1024 ** 3
const big = 930 * GB // a 930 GB disk, like Corey's C:

// ── healthy: lots free → ok ──
assert.equal(diskAlertLevel({ freeBytes: 700 * GB, totalBytes: big }).level, 'ok', '700 GB free is ok')

// ── the failure mode: 750 MB free on a 930 GB disk → critical ──
const atCrash = diskAlertLevel({ freeBytes: 0.75 * GB, totalBytes: big })
assert.equal(atCrash.level, 'critical', '750 MB free (the actual SIGBUS condition) is critical')
assert.ok(atCrash.freeGb < 1, 'freeGb reported')

// ── absolute GB is the DEFAULT trigger; percent OFF so huge disks don't cry wolf ──
assert.equal(diskAlertLevel({ freeBytes: 8 * GB, totalBytes: big }).level, 'warn', '8 GB free → warn (< warnGb), NOT critical despite <1% (percent off by default)')
assert.equal(diskAlertLevel({ freeBytes: 1.5 * GB, totalBytes: big }).level, 'critical', '1.5 GB free → critical (< critGb)')
assert.equal(diskAlertLevel({ freeBytes: 30 * GB, totalBytes: big }).level, 'ok', '30 GB free → ok by default (3% but percent off — no big-disk false alarm)')

// ── critical overrides warn (both GB conditions met → critical) ──
assert.equal(diskAlertLevel({ freeBytes: 1 * GB, totalBytes: big }).level, 'critical', 'critical wins over warn')

// ── percent floor is OPT-IN (for small disks): enable via policy ──
const pctPolicy = { warnGb: 0, critGb: 0, warnPct: 10, critPct: 3 }
const small = 50 * GB
assert.equal(diskAlertLevel({ freeBytes: 1 * GB, totalBytes: small }, pctPolicy).level, 'critical', '1 GB / 2% with percent policy → critical')
assert.equal(diskAlertLevel({ freeBytes: 4 * GB, totalBytes: small }, pctPolicy).level, 'warn', '4 GB / 8% with percent policy → warn')
assert.equal(diskAlertLevel({ freeBytes: 12 * GB, totalBytes: small }, pctPolicy).level, 'ok', '12 GB / 24% → ok')

// ── totalBytes 0 (unknown) → treat as 100% free, never false-alarm ──
assert.equal(diskAlertLevel({ freeBytes: 0, totalBytes: 0 }).level, 'ok', 'unknown total never false-alarms')

// ── policyFromEnv: defaults + overrides ──
assert.deepEqual(policyFromEnv({}), DEFAULT_DISK_POLICY, 'empty env → defaults')
const p = policyFromEnv({ CKN_DISK_WARN_GB: '20', CKN_DISK_CRIT_GB: '5' })
assert.equal(p.warnGb, 20, 'warnGb overridden')
assert.equal(p.critGb, 5, 'critGb overridden')
assert.equal(p.warnPct, DEFAULT_DISK_POLICY.warnPct, 'unset stays default')
const bad = policyFromEnv({ CKN_DISK_WARN_GB: 'nonsense' })
assert.equal(bad.warnGb, DEFAULT_DISK_POLICY.warnGb, 'non-numeric env falls back to default')

// ── checkDiskPaths: real HOME reads ok; a missing path reports error + does NOT alert ──
const res = await checkDiskPaths([os.homedir(), '/no/such/path/zzz'])
const home = res.find((r) => r.path === os.homedir())
assert.ok(home && ['ok', 'warn', 'critical'].includes(home.level), 'HOME yields a real reading')
const missing = res.find((r) => r.path === '/no/such/path/zzz')
assert.ok(missing && missing.error, 'missing path reports an error')
assert.equal(missing.level, 'ok', 'a missing/unreadable path never alerts (no cry-wolf)')

console.log('disk-guard OK')
process.exit(0)
