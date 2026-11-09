import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import { backupMemory, listBackups, restoreBackup } from '../core/backup.js'
import { isolatedEnv } from './isolatedEnv.js'

const REPO = path.resolve(import.meta.dirname, '..')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const withEnv = <T>(env: NodeJS.ProcessEnv, fn: () => T): T => {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try {
    return fn()
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
}

test('a backup holds the memory dirs and restores them byte for byte', () => {
  const { env, root } = isolatedEnv()
  dirs.push(root)
  const file = path.join(env.CKN_MEMORY_DIRS!, 'm.md')
  fs.writeFileSync(file, 'the original\n')
  withEnv(env, () => {
    const b = backupMemory('test', REPO)
    assert.ok(b.paths.includes(env.CKN_MEMORY_DIRS!))
    assert.equal(listBackups().length, 1)
    fs.writeFileSync(file, 'damaged\n')
    restoreBackup(b.file, REPO)
  })
  assert.equal(fs.readFileSync(file, 'utf-8'), 'the original\n')
})

test('install refuses to run when the backup cannot be taken', () => {
  const { env, root } = isolatedEnv()
  dirs.push(root)
  fs.mkdirSync(env.CKN_STATE_DIR!, { recursive: true })
  fs.writeFileSync(path.join(env.CKN_STATE_DIR!, 'backups'), 'not a directory')
  const r = spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-install.ts')], { env, encoding: 'utf-8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /refused/)
  assert.equal(fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json')), false, 'nothing was installed')
})
