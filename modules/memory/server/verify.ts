/**
 * The graph is derived from the journal; this finds where it has fallen behind. A memory this
 * machine wrote whose latest record has no graph row (none with its text, none with its name) is
 * in the journal, syncs to other nodes, and is still not recallable here. A rename of a note with
 * unchanged text is folded into its earlier row: not missing. Session checkpoints stay out of the graph by design and are not counted. `repair` writes the missing ones into the graph through the same
 * reconcile as adoption, without appending to the journal again.
 */
import { bodyOf } from './consume.js'
import { frontmatterOf } from './frontmatter.js'
import { materialize } from './ingest.js'
import { hashContent, type Journal } from './journal.js'
import { reconcile } from './reconcile.js'
import type { MemoryStore } from './store.js'

export type VerifyReport = { checked: number; missing: { seq: number; slug: string; source: string }[]; repaired: string[] }

// Checkpoints by what they say, or by the names the hooks give them: the 13 Oct incident left
// placeholders with neither frontmatter nor text under those names, and they belong out of the graph too.
const checkpoint = (slug: string, content: string) =>
  /^(session|precompact)-/.test(slug) || frontmatterOf(content).authorship === 'extracted' || /^id:\s*session:/m.test(content)

export const verify = (store: MemoryStore, journal: Journal, machine: string, opts: { repair?: boolean } = {}): VerifyReport => {
  const latest = new Map<string, ReturnType<Journal['replay']>[number]>()
  // This machine's own records only: those adopted from others are theirs to have.
  for (const r of journal.replay()) if (r.kind === 'memory' && r.machine === machine && r.slug && !checkpoint(r.slug, r.content)) latest.set(r.slug, r)
  const names = new Set(store.all().map((m) => m.name))
  // Missing only if ingest would write it: a record whose text a row already holds (a rename of the
  // same note, say) folds into that row, and is recallable there.
  const missing = [...latest.values()].filter((r) => {
    if (names.has(r.slug!)) return false
    const body = bodyOf(r.content)
    return reconcile({ slug: r.slug!, scope: r.scope, content: body, contentHash: hashContent(body), machine: r.machine, isRule: false }, { store }).action !== 'fold'
  })
  const repaired = opts.repair ? missing.map((r) => materialize(r as never, { store, journal }, Date.now, { own: true })) : []
  return { checked: latest.size, missing: missing.map((r) => ({ seq: r.seq, slug: r.slug!, source: r.source })), repaired }
}
