/**
 * cortex-public-check --export: the public tree is made only from a tree that passes the gate,
 * and holds exactly the exportable files.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'public-check-'))

const repoWith = (files: Record<string, string>) => {
  const dir = tmp()
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), body)
  }
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  return dir
}
const run = (...args: string[]) =>
  spawnSync(path.join(root, 'node_modules', '.bin', 'tsx'), [path.join(root, 'bin', 'cortex-public-check.ts'), ...args], { encoding: 'utf-8' })

const base = { '.public-names': 'privatename\n', '.public-exclude': 'secret-module/\n.public-exclude\n.public-names\n', 'README.md': 'hello\n', 'secret-module/a.txt': 'privatename\n' }

test('export copies exactly the exportable files when the tree passes', () => {
  const repo = repoWith(base)
  const out = path.join(tmp(), 'export')
  const r = run('--repo', repo, '--export', out)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(fs.readdirSync(out).sort(), ['README.md'])
})

test('export refuses, and writes nothing, when a name is left', () => {
  const repo = repoWith({ ...base, 'docs/x.md': 'see privatename\n' })
  const out = path.join(tmp(), 'export')
  const r = run('--repo', repo, '--export', out)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /names: 1 line/)
  assert.equal(fs.existsSync(out), false)
})

test('export refuses a target that already has files in it', () => {
  const repo = repoWith(base)
  const out = tmp()
  fs.writeFileSync(path.join(out, 'stale'), '')
  const r = run('--repo', repo, '--export', out)
  assert.equal(r.status, 2)
  assert.deepEqual(fs.readdirSync(out), ['stale'])
})

test('this tree passes the public gate: no private name, no secret outside tests', { skip: !fs.existsSync(path.join(root, '.public-names')) && 'the public tree carries no name list' }, () => {
  const r = run()
  assert.equal(r.status, 0, r.stdout)
})

test('--loose prints every raw substring hit for a person to read, and never changes the verdict', () => {
  const repo = repoWith({ ...base, '.public-loose': 'privatename\nwidget\n', '.public-exclude': base['.public-exclude'] + '.public-loose\n', 'docs/a.md': 'two widgets\n' })
  const r = run('--repo', repo, '--loose')
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /loose: 1 line/)
  assert.match(r.stdout, /docs\/a\.md:1: two widgets/)
})

test('a memory shipped outside tests fails the gate; generators and tests do not', () => {
  const memory = '---\nname: a-real-memory\ndescription: something someone decided\ntype: project\n---\n\nThe body.\n'
  const generator = 'const raw = `---\\nname: ${slug}\\ndescription: ${d}\\n---\\n\\n${body}`\n'
  const yaml = '# --- a section ---------------\nservices:\n  x:\n    container_name: x\nvolumes:\n  v:\n    name: v\n'
  const pass = repoWith({ ...base, 'core/gen.ts': generator, 'compose.yaml': yaml, 'modules/m/test/fixture.md': memory })
  assert.equal(run('--repo', pass).status, 0, run('--repo', pass).stdout)
  const fail = repoWith({ ...base, 'docs/notes/decided.md': memory, 'core/seed.ts': "export const seed = '---\\nname: shipped-seed\\ndescription: x\\n---\\nbody'\n" })
  const r = run('--repo', fail)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /memories: 2 file\(s\)/)
  assert.match(r.stdout, /docs\/notes\/decided\.md/)
  assert.match(r.stdout, /core\/seed\.ts/)
})
