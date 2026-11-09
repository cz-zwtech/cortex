/**
 * What a memory's frontmatter says about it: its description and its kind.
 *
 * Ingest used to store every memory with an empty description and shape
 * `observation`, so a standing directive looked exactly like an ops note and
 * the session-start set fell back to recency. The writer had already said which
 * was which; this reads it.
 *
 * The corpus carries the kind in three places, depending on which tool wrote
 * it: `type:`, `metadata: type:` (the harness normaliser nests it), and
 * `node_type:` (V1 threads). `memory` is V1's catch-all and says nothing.
 * `kind: precompact-checkpoint` marks V1's pre-compaction transcript captures,
 * and `authorship: auto-extracted` marks V1's mined tool-error patterns.
 */
import type { Authorship, Shape } from './types.js'

/** `standing`: always loaded at session start (the standing rules), from `standing: true`. */
export type Frontmatter = { description: string; shape: Shape; authorship: Authorship; standing: boolean }

const TYPE_TO_SHAPE: Record<string, Shape> = {
  feedback: 'feedback',
  user: 'feedback', // a preference is a standing rule for every session
  thread: 'thread',
  reference: 'reference',
  decision: 'decision',
  error: 'error',
  workflow: 'workflow',
  pattern: 'pattern',
  observation: 'observation',
  project: 'observation',
}

const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, '$2').trim()

export const frontmatterOf = (content: string): Frontmatter => {
  const m = content.match(/^\s*---\s*\n([\s\S]*?)\n---/)
  if (!m) return { description: '', shape: 'observation', authorship: 'authored', standing: false }

  let description = ''
  let kind = ''
  let declaredAuthorship = ''
  let standing = false
  const types: string[] = []
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = line.match(/^(\s*)([A-Za-z_]+):\s*(.*)$/)
    if (!kv) continue
    const [, indent, key, value] = kv
    if (!indent && key === 'description') description = unquote(value!)
    if (!indent && key === 'kind') kind = unquote(value!).toLowerCase()
    if (!indent && key === 'authorship') declaredAuthorship = unquote(value!).toLowerCase()
    if (key === 'type' || key === 'node_type') types.push(unquote(value!).toLowerCase())
    // Top level or nested (the normaliser moves keys under metadata:), like type.
    if (key === 'standing') standing = unquote(value!).toLowerCase() === 'true'
  }

  // A thread anywhere wins: it is the one kind that carries resumable state.
  const shape = types.includes('thread')
    ? 'thread'
    : (types.map((t) => TYPE_TO_SHAPE[t]).find(Boolean) ?? 'observation')
  // A session checkpoint is transcript captured by a hook, not a memory anyone
  // wrote. It stays in the journal and out of recall and the start set.
  // V1 pattern memories declare `authorship: auto-extracted`: mined from
  // fail-then-success tool traces, not written by anyone.
  // Consolidation's own memories (tool lessons) declare `authorship: derived`.
  const authorship: Authorship =
    kind.endsWith('checkpoint') || declaredAuthorship.endsWith('extracted') ? 'extracted' : declaredAuthorship === 'derived' ? 'derived' : 'authored'
  return { description, shape, authorship, standing }
}
