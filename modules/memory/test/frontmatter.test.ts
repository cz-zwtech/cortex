import assert from 'node:assert/strict'
import test from 'node:test'

import { frontmatterOf } from '../server/frontmatter.js'

const fm = (lines: string) => `---\n${lines}\n---\n\nbody\n`

test('the description and kind the writer declared are read, wherever the tool put them', () => {
  assert.deepEqual(frontmatterOf(fm('name: a\ndescription: what it is\ntype: feedback')), { description: 'what it is', shape: 'feedback', authorship: 'authored', standing: false })
  assert.deepEqual(frontmatterOf(fm('name: a\ndescription: "quoted"\nmetadata:\n  type: user')), { description: 'quoted', shape: 'feedback', authorship: 'authored', standing: false })
  assert.equal(frontmatterOf(fm('name: t\nnode_type: thread\ntype: memory')).shape, 'thread')
  assert.equal(frontmatterOf(fm('name: r\nmetadata:\n  type: reference')).shape, 'reference')
})

test('an unknown or catch-all kind, or no frontmatter, is an observation', () => {
  assert.equal(frontmatterOf(fm('name: a\ntype: memory')).shape, 'observation')
  assert.deepEqual(frontmatterOf('just prose, no fences'), { description: '', shape: 'observation', authorship: 'authored', standing: false })
})

test('a nested description is not mistaken for the memory description', () => {
  assert.equal(frontmatterOf(fm('name: a\nmetadata:\n  description: nested')).description, '')
})

test('a session checkpoint is extracted text, not an authored memory', () => {
  const v1 = fm('name: precompact-02a8413a-2026-08-19T21-28-14-721Z\ntype: memory\nkind: precompact-checkpoint')
  assert.equal(frontmatterOf(v1).authorship, 'extracted')
})

test('standing: true marks a standing rule, at the top level or nested under metadata', async () => {
  const { frontmatterOf } = await import('../server/frontmatter.js')
  assert.equal(frontmatterOf('---\nname: a\nstanding: true\n---\nx').standing, true)
  assert.equal(frontmatterOf('---\nname: a\nmetadata:\n  type: feedback\n  standing: true\n---\nx').standing, true)
  assert.equal(frontmatterOf('---\nname: a\nstanding: false\n---\nx').standing, false)
  assert.equal(frontmatterOf('no front matter').standing, false)
})
