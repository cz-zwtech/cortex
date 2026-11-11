/**
 * Removing a module sticks: `cortex-setup module remove` records it, and an install or an update
 * (which runs the install) leaves it out until `module add` brings it back. Dependencies are
 * checked both ways.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import { isolatedEnv } from './isolatedEnv.js'

const REPO = path.resolve(import.meta.dirname, '..')
const tsx = path.join(REPO, 'node_modules', '.bin', 'tsx')
const { env, root } = isolatedEnv()
after(() => fs.rmSync(root, { recursive: true, force: true }))

const run = (bin: string, ...args: string[]) => spawnSync(tsx, [path.join(REPO, 'bin', bin), ...args], { env, encoding: 'utf-8', cwd: REPO })
const modules = () => fs.readdirSync(path.join(env.CKN_STATE_DIR!, 'modules')).sort()
const command = (name: string) => fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR!, 'commands', `cortex-${name}.md`))

test('a removed module stays removed through an install, and add brings it back', () => {
  const install = run('cortex-install.ts', 'install', '--no-mesh-start')
  assert.equal(install.status, 0, install.stderr)
  assert.ok(modules().includes('telegram'))
  assert.ok(command('telegram'))

  const removed = run('cortex-setup.ts', 'module', 'remove', 'telegram')
  assert.equal(removed.status, 0, removed.stdout + removed.stderr)
  assert.ok(!modules().includes('telegram'))
  assert.ok(!command('telegram'), 'its command is gone')
  assert.match(removed.stdout, /data/, 'says where its data stays')

  const again = run('cortex-install.ts', 'install', '--no-mesh-start')
  assert.equal(again.status, 0, again.stderr)
  assert.ok(!modules().includes('telegram'), 'the install leaves it out')
  assert.match(again.stdout, /telegram.*removed/)

  const added = run('cortex-setup.ts', 'module', 'add', 'telegram')
  assert.equal(added.status, 0, added.stdout + added.stderr)
  assert.ok(modules().includes('telegram'))
  assert.ok(command('telegram'))
})

test('remove refuses a module another installed one requires, and names it', () => {
  const r = run('cortex-setup.ts', 'module', 'remove', 'comms')
  assert.notEqual(r.status, 0)
  assert.match(r.stdout + r.stderr, /gateway|private-mind/)
  assert.ok(modules().includes('comms'), 'nothing was removed')
})

test('add refuses a module whose requirement is removed', () => {
  assert.equal(run('cortex-setup.ts', 'module', 'remove', 'private-mind').status, 0)
  assert.equal(run('cortex-setup.ts', 'module', 'remove', 'memory').status, 0)
  const r = run('cortex-setup.ts', 'module', 'add', 'private-mind')
  assert.notEqual(r.status, 0)
  assert.match(r.stdout + r.stderr, /memory/)
  assert.ok(!modules().includes('private-mind'))
  assert.equal(run('cortex-setup.ts', 'module', 'add', 'memory').status, 0)
  assert.equal(run('cortex-setup.ts', 'module', 'add', 'private-mind').status, 0)
})

test('list shows every module in the checkout and its state', () => {
  assert.equal(run('cortex-setup.ts', 'module', 'remove', 'telegram').status, 0)
  const r = run('cortex-setup.ts', 'module', 'list')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /comms\s+installed/)
  assert.match(r.stdout, /telegram\s+removed/)
})
