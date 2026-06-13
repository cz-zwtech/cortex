/**
 * Local onboarding seed — write the bundled {@link ONBOARDING_MEMORIES} into the
 * LOCAL SQLite graph under scope `shared:cortex`, with no remote/team-mind needed.
 *
 * This is the "encapsulated in the repo" delivery channel: every install can
 * seed the operating knowledge from disk, independent of whether the user has a
 * team shared-mind. Idempotent — stable ids (`shared:cortex/<slug>`) upsert in
 * place, so re-seeding just refreshes content.
 *
 * Pure graph writes. The caller still wraps this in withGraphWriteLock (the route
 * + boot path do) — now a passthrough — but each memory's delete+insert is also
 * made atomic here via transaction(). Mirrors the shared-sync import upsert,
 * sourced from the bundled corpus.
 */
import { run, transaction } from '../graph/db.js'
import { ONBOARDING_MEMORIES, ONBOARDING_SCOPE } from './corpus.js'

export interface SeedResult {
  seeded: number
  scope: string
}

/** Upsert every onboarding memory under `shared:cortex`. Returns the count. */
export async function seedOnboardingLocal(): Promise<SeedResult> {
  const now = Date.now()
  let seeded = 0
  for (const m of ONBOARDING_MEMORIES) {
    const id = `${ONBOARDING_SCOPE}/${m.id}`
    try {
      // Detach-delete then re-create: drop incident edges + the row, then
      // re-insert. Atomic so a reader never sees a half-rebuilt node.
      transaction(() => {
        run('DELETE FROM edges WHERE src = ? OR dst = ?', id, id)
        run('DELETE FROM entries WHERE id = ?', id)
        run(
          `INSERT INTO entries
             (id, name, kind, description, content, source, scope, pinned, updatedAt, syncedAt)
           VALUES (?, ?, 'memory', ?, ?, ?, ?, ?, ?, ?)`,
          id,
          m.title,
          m.description,
          m.body.slice(0, 8192),
          `onboarding:${m.id}`,
          ONBOARDING_SCOPE,
          m.pinned ? 1 : 0,
          now,
          now,
        )
      })
      seeded++
    } catch {
      /* skip a single bad row rather than fail the whole seed */
    }
  }
  return { seeded, scope: ONBOARDING_SCOPE }
}
