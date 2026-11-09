/**
 * Which node should take a request for a role that lives on several?
 *
 * The design: "inferring, which captures everything for a suggestion. Prior work,
 * existing focus, etc. if nothing matches, then its no suggestion." So the
 * evidence is what each node's role has worked on before (messages sent to it)
 * and what its members say they do (capabilities and focus), each matched
 * against the request's words. Words every candidate shares say nothing about
 * which one, so they do not count. A suggestion needs a clear winner.
 */
import { words } from './directory.js'

export type NodeCandidate = {
  /** How the person writes it: node-a:web-dev */
  address: string
  /** Members' capabilities and focus. */
  about: string[]
  /** What was asked of this node's role before, newest first. */
  prior: string[]
}

export type Suggestion = { address: string; reason: string }

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s)

export const suggestNode = (request: string, candidates: NodeCandidate[]): Suggestion | undefined => {
  const q = new Set(words(request))
  if (!q.size || candidates.length < 2) return undefined
  // A word found in every candidate's evidence does not tell them apart.
  const evidence = candidates.map((c) => new Set(words([...c.about, ...c.prior].join(' '))))
  const telling = (w: string) => q.has(w) && evidence.some((e) => !e.has(w))

  const scored = candidates.map((c) => {
    const aboutHits = [...new Set(words(c.about.join(' ')))].filter(telling)
    let best = { hits: 0, subject: '' }
    let priorScore = 0
    for (const subject of c.prior) {
      const hits = [...new Set(words(subject))].filter(telling).length
      priorScore += hits
      if (hits > best.hits) best = { hits, subject }
    }
    const score = 2 * aboutHits.length + priorScore
    const reason = best.hits
      ? `it worked on "${clip(best.subject)}" before`
      : aboutHits.length
        ? `its members list ${aboutHits.join(', ')}`
        : ''
    return { c, score, reason }
  })
  scored.sort((a, b) => b.score - a.score)
  const [top, next] = scored
  if (!top || top.score === 0 || (next && next.score === top.score)) return undefined
  return { address: top.c.address, reason: top.reason }
}
