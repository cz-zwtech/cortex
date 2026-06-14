#!/usr/bin/env tsx
/**
 * #111 loud layer — the /cortex-sync slash command is registered in COMMANDS (so first boot
 * installs ~/.claude/commands/cortex-sync.md) and its body carries the required orchestration:
 * fold locally, then bidirectional ckn-mind-sync, graceful when no remote, plus the two doc
 * guarantees (fresh-without-restart; intentional cross-node pull).
 */
import assert from 'node:assert/strict'

const { COMMANDS } = await import('../../server/hookRegistrar.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const cmd = COMMANDS.find((c: { name: string }) => c.name === 'cortex-sync')
assert.ok(cmd, 'cortex-sync is registered in COMMANDS (installs to ~/.claude/commands/cortex-sync.md)')
ok('cortex-sync registered')

assert.match(cmd!.body, /ckn-sync\.ts/, 'folds the local graph (ckn-sync) before the remote reconcile')
ok('local fold via ckn-sync')
assert.match(cmd!.body, /ckn-mind-sync\.ts/, 'runs the bidirectional remote engine (ckn-mind-sync)')
ok('bidirectional remote via ckn-mind-sync (push + pull+adopt)')
assert.match(cmd!.body, /no remote configured/i, 'graceful no-remote (private mind is opt-in)')
ok('graceful no-remote case')
assert.match(cmd!.body, /no restart/i, 'documents post-sync freshness without restart (constraint 4)')
ok('documents fresh-without-restart')
assert.match(cmd!.body, /by design/i, 'documents intentional cross-node pull, not a gap (constraint 5)')
ok('documents intentional cross-node pull')

console.log(`\n${passed} assertions passed.`)
process.exit(0)
