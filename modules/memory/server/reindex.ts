/**
 * Re-derive what ingest reads from frontmatter, for memories already ingested.
 *
 * Ingest once dropped every description and stored every memory as an
 * observation, and stored session checkpoints as authored memories. The memory files are stubs by now, so the files cannot be
 * re-swept; the journal still holds each memory's full original text, so the
 * fields are recomputed from there. Only description, shape, authorship and rule fields change
 * (a rule whose fields the harness normaliser nested under metadata: was once read as no rule).
 */
import { frontmatterOf } from './frontmatter.js'
import type { Journal } from './journal.js'
import { ruleOf } from './rules.js'
import type { MemoryStore } from './store.js'

export type ReindexReport = { checked: number; changed: number; noJournal: number }

export const reindex = (store: MemoryStore, journal: Journal, apply: boolean): ReindexReport => {
  const byHash = new Map(journal.replay().map((r) => [r.contentHash, r]))
  const report: ReindexReport = { checked: 0, changed: 0, noJournal: 0 }
  const rules = new Map(store.rules().map(({ id, name: _n, since: _s, ...fields }) => [id, JSON.stringify(fields)]))

  for (const m of store.all()) {
    report.checked++
    const record = byHash.get(store.journalHashOf(m.id) ?? '')
    if (!record) {
      report.noJournal++
      continue
    }
    const { description, shape, authorship } = frontmatterOf(record.content)
    const rule = ruleOf(record.content)
    const ruleChanged = rule !== null && JSON.stringify(rule) !== rules.get(m.id)
    if (description === m.description && shape === m.shape && authorship === m.authorship && !ruleChanged) continue
    report.changed++
    if (apply) {
      store.setDerived(m.id, description, shape, authorship)
      if (ruleChanged) store.setRule(m.id, rule)
    }
  }
  return report
}
