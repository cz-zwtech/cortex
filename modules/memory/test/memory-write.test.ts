import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import { isolatedEnv } from '../../../test/isolatedEnv.js'
import { writtenMemoryDirs } from '../server/on-memory-write.js'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const run = (env: NodeJS.ProcessEnv, script: string, ...args: string[]) =>
  spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', script), ...args], { env, encoding: 'utf-8' })
const postToolUse = (env: NodeJS.ProcessEnv, tool_name: string, tool_input: object) =>
  spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-hook.ts'), 'PostToolUse'], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name, tool_input }),
    env,
    encoding: 'utf-8',
  })

test('only a markdown write into a memory dir, or a shell command naming one, counts', () => {
  const mem = '/home/x/.claude/memory'
  assert.deepEqual(writtenMemoryDirs({ tool_name: 'Write', tool_input: { file_path: `${mem}/a.md` } }, [mem]), [mem])
  assert.deepEqual(writtenMemoryDirs({ tool_name: 'Edit', tool_input: { file_path: `${mem}/a.txt` } }, [mem]), [])
  assert.deepEqual(writtenMemoryDirs({ tool_name: 'Write', tool_input: { file_path: '/home/x/notes/a.md' } }, [mem]), [])
  assert.deepEqual(writtenMemoryDirs({ tool_name: 'Bash', tool_input: { command: `cat > ${mem}/b.md <<EOF` } }, [mem]), [mem])
  assert.deepEqual(writtenMemoryDirs({ tool_name: 'Read', tool_input: { file_path: `${mem}/a.md` } }, [mem]), [])
})

test('a memory written mid-session is recallable at once, and the file stays whole for further edits', () => {
  const { env, root } = isolatedEnv({ CKN_MODULES_DIR: path.join(REPO, 'modules'), CLAUDE_CODE_ENTRYPOINT: 'cli' })
  dirs.push(root)
  const file = path.join(env.CKN_MEMORY_DIRS!, 'desk-pdf-tools.md')
  const body = '---\nname: desk-pdf-tools\ndescription: The desk machine reads PDFs with pdftotext from poppler.\n---\n\nUse pdftotext -layout.\n'
  fs.writeFileSync(file, body)

  assert.doesNotMatch(run(env, 'cortex-memory.ts', 'recall', 'pdf', 'tools', 'poppler').stdout, /desk-pdf-tools/, 'not ingested before the hook')
  assert.equal(postToolUse(env, 'Write', { file_path: file }).status, 0)
  assert.match(run(env, 'cortex-memory.ts', 'recall', 'pdf', 'tools', 'poppler').stdout, /desk-pdf-tools/, 'recallable in the same session')
  assert.equal(fs.readFileSync(file, 'utf-8'), body, 'not stubbed mid-session')

  // An edit a minute later lands on the whole file, and recall sees the new text.
  fs.writeFileSync(file, body.replace('pdftotext -layout.', 'pdftotext -layout; pdftoppm for page images.'))
  postToolUse(env, 'Edit', { file_path: file })
  assert.match(run(env, 'cortex-memory.ts', 'recall', 'pdftoppm', 'page', 'images').stdout, /desk-pdf-tools/)
})
