/**
 * Every CLI answers --help and -h with its usage, exit 0, and no side effects.
 *
 * The entry points are listed from bin/ and modules/<name>/bin/, so a new CLI is
 * covered without touching this file. stdin stays open and unwritten: a command
 * that reads it before handling --help (the hook, the status line) hangs and
 * is killed, which fails the test.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import { isolatedEnv } from './isolatedEnv.js'

const REPO = path.resolve(import.meta.dirname, '..')
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx')
const LIMIT_MS = 20_000

const binDirs = [path.join(REPO, 'bin'), ...fs.readdirSync(path.join(REPO, 'modules')).map((m) => path.join(REPO, 'modules', m, 'bin'))]
const entryPoints = binDirs
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => fs.readdirSync(d).map((f) => path.join(d, f)))
  .filter((f) => /\.(ts|sh)$/.test(f))
  .sort()

const roots: string[] = []
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })))

/** Every path under root, except tsx's own transpile cache in the temp dir. */
const snapshot = (root: string): string[] =>
  (fs.readdirSync(root, { recursive: true }) as string[]).filter((p) => !/^tmp\/tsx-/.test(p)).sort()

const run = (file: string, flag: string): Promise<{ code: number | null; out: string; written: string[]; before: string[] }> => {
  const { env, root } = isolatedEnv({ CKN_MODULES_DIR: path.join(REPO, 'modules') })
  roots.push(root)
  const cwd = path.join(root, 'cwd')
  const tmp = path.join(root, 'tmp')
  fs.mkdirSync(cwd)
  fs.mkdirSync(tmp)
  env.TMPDIR = tmp
  const before = snapshot(root)
  const [cmd, args] = file.endsWith('.ts') ? [TSX, [file, flag]] : ['bash', [file, flag]]
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => process.kill(-child.pid!, 'SIGKILL'), LIMIT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, written: snapshot(root), before })
    })
  })
}

test('every CLI answers --help and -h', { concurrency: 8 }, async (t) => {
  await Promise.all(
    entryPoints.flatMap((file) =>
      ['--help', '-h'].map((flag) =>
        t.test(`${path.relative(REPO, file)} ${flag}: usage, exit 0, nothing written`, { timeout: LIMIT_MS + 5_000 }, async () => {
          const r = await run(file, flag)
          assert.equal(r.code, 0, `exit ${r.code}: ${r.out.slice(0, 400)}`)
          assert.match(r.out, new RegExp(`usage|${path.basename(file, path.extname(file))}`, 'i'))
          assert.deepEqual(r.written, r.before, 'files appeared in the sandbox')
        }),
      ),
    ),
  )
})
