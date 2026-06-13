/**
 * Thread hydrate — the resume-UX DEPTH follow-on (ratified parallelism principle
 * [[cortex-resume-ux-and-parallelism-design]]). After the fast resume head+ACK
 * returns, the "how did we get here?" back-story hydrates IN PARALLEL: every
 * linked memory is fetched concurrently (one call = the whole back-story) so the
 * main session stays responsive while depth assembles behind it.
 *
 * The fetch is injected so this is testable without a server; ckn-threads wires
 * the real API fetch (search the slug → exact-name entry → node content).
 */
export interface LinkContent {
  slug: string
  found: boolean
  description?: string
  excerpt?: string
  truncated?: boolean
}

export type LinkFetcher = (slug: string) => Promise<{ description?: string; body?: string } | null>

const EXCERPT = 280
const FAN_OUT = 8 // bounded concurrency — a thread carrying 100+ links won't open 100 sockets at once

async function fetchLink(slug: string, fetchOne: LinkFetcher): Promise<LinkContent> {
  try {
    const c = await fetchOne(slug)
    if (!c) return { slug, found: false }
    const body = (c.body ?? '').trim()
    return { slug, found: true, description: c.description, excerpt: body.slice(0, EXCERPT), truncated: body.length > EXCERPT }
  } catch {
    return { slug, found: false }
  }
}

/** Fan the per-link fetches out concurrently in bounded chunks (FAN_OUT at a
 *  time), preserving input order. A missing entry or a throwing fetch degrades to
 *  found:false — one bad link never sinks the bundle. */
export async function hydrateLinks(links: string[], fetchOne: LinkFetcher): Promise<LinkContent[]> {
  const out: LinkContent[] = []
  for (let i = 0; i < links.length; i += FAN_OUT) {
    const chunk = links.slice(i, i + FAN_OUT)
    out.push(...(await Promise.all(chunk.map((slug) => fetchLink(slug, fetchOne)))))
  }
  return out
}

/** Format the hydrated back-story bundle. Leads with the thread + next_step
 *  (orientation), then each linked memory's description + excerpt; unresolved
 *  links are flagged as unwritten forward-links rather than silently dropped. */
export function renderHydrate(thread: { id: string; nextStep?: string }, results: LinkContent[]): string {
  const lines = [
    `BACK-STORY for ${thread.id} (${results.length} linked memor${results.length === 1 ? 'y' : 'ies'})`,
  ]
  if (thread.nextStep) lines.push(`next_step: ${thread.nextStep}`)
  lines.push('')
  for (const r of results) {
    if (!r.found) {
      lines.push(`▸ ${r.slug}  — not found in graph (likely an unwritten forward-link)`)
      continue
    }
    lines.push(`▸ ${r.slug}${r.description ? `  — ${r.description}` : ''}`)
    if (r.excerpt) lines.push(`  ${r.excerpt}${r.truncated ? '…' : ''}`)
  }
  return lines.join('\n')
}
