/**
 * Profile adapter — the AI's evidence-grounded PERCEPTION of the human.
 *
 * Shapes mirror `server/graph/profile.ts` exactly. The view is strictly
 * READ-ONLY: perception is not human-editable, so this adapter only reads.
 * `getProfile()` calls `/api/profile` with NO `min` param, so the server
 * returns ALL active facets (one per competing_group), confidence visible.
 */

export interface Facet {
  id: string
  dimension: string
  facet_key: string
  stance: string
  statement: string
  valence: 'like' | 'dislike' | 'trait' | 'neutral'
  competing_group: string
  confidence: number
  trend: 'stable' | 'strengthening' | 'weakening' | 'stale'
  evidence_count: number
  first_observed: number
  last_observed: number
}

export interface ProfileView {
  narrative: string
  facets: Facet[]
}

export async function getProfile(): Promise<ProfileView> {
  const res = await fetch('/api/profile')
  return res.json()
}
