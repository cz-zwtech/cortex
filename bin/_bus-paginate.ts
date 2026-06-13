/**
 * Bus message pagination — split a long body into mesh-safe parts and reassemble
 * them at the read layer. Within the protocol freeze: pagination rides in the
 * message BODY (a self-describing header line), so no new message fields/frames
 * are added and an older node still reads each part as a normal message. The
 * sender splits; each of the read surfaces (inbox, watch, ckn-pause-context)
 * reassembles.
 *
 * Header (first line of a part body): `[[ckn-page <groupId> <k>/<n>]]`, then a
 * newline, then the chunk. Reassembly groups by groupId with idempotent
 * SET-semantics (dedupe by k), joins the chunks in k-order once all n parts are
 * present, and passes non-paginated or still-incomplete messages through
 * untouched (so nothing is ever silently dropped).
 */

/** Per-part chunk size for split-on-send. Conservative default keeps a part
 * inside mesh-frame limits; override with CKN_BUS_PAGE_LIMIT. */
export const DEFAULT_PAGE_LIMIT = Math.max(256, Number(process.env.CKN_BUS_PAGE_LIMIT ?? '1500'))

const HEADER_RE = /^\[\[ckn-page (\S+) (\d+)\/(\d+)\]\]\n([\s\S]*)$/

export interface PageHeader {
  groupId: string
  k: number
  n: number
  chunk: string
}

/** Parse a part's body-header, or null when the body isn't a paginated part. */
export function parsePageHeader(body: string): PageHeader | null {
  const m = HEADER_RE.exec(body)
  if (!m) return null
  const k = Number(m[2])
  const n = Number(m[3])
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 1 || n < 1 || k > n) return null
  return { groupId: m[1]!, k, n, chunk: m[4] ?? '' }
}

/**
 * Split `body` into header-tagged parts of at most `limit` chunk chars each.
 * A body within the limit is returned UNCHANGED as a single element (no header)
 * so ordinary messages are never rewritten.
 */
export function paginateBody(body: string, groupId: string, limit: number): string[] {
  if (body.length <= limit) return [body]
  const chunks: string[] = []
  for (let i = 0; i < body.length; i += limit) chunks.push(body.slice(i, i + limit))
  const n = chunks.length
  return chunks.map((chunk, i) => `[[ckn-page ${groupId} ${i + 1}/${n}]]\n${chunk}`)
}

/**
 * Reassemble a list of messages: complete paginated groups collapse to one
 * message (the k=1 part's metadata + the joined body), carrying `partIds` for
 * every constituent part so a caller can mark them all delivered. Non-paginated
 * messages and still-incomplete groups pass through unchanged, each tagged with
 * its own `partIds`. Order is preserved, with a merged group placed at its first
 * part's position. Idempotent: duplicate parts (same groupId+k) are deduped.
 */
export function reassembleList<T extends { id: string; body: string }>(
  msgs: T[],
): Array<T & { partIds: string[] }> {
  // Pass 1: collect paginated parts by group (SET-semantics dedupe on k).
  const groups = new Map<string, { n: number; byK: Map<number, T> }>()
  for (const msg of msgs) {
    const h = parsePageHeader(msg.body)
    if (!h) continue
    let g = groups.get(h.groupId)
    if (!g) {
      g = { n: h.n, byK: new Map() }
      groups.set(h.groupId, g)
    }
    if (!g.byK.has(h.k)) g.byK.set(h.k, msg)
  }

  // Pass 2: emit in original order; act on a group only at its first part.
  const out: Array<T & { partIds: string[] }> = []
  const emitted = new Set<string>()
  for (const msg of msgs) {
    const h = parsePageHeader(msg.body)
    if (!h) {
      out.push({ ...msg, partIds: [msg.id] })
      continue
    }
    if (emitted.has(h.groupId)) continue
    emitted.add(h.groupId)
    const g = groups.get(h.groupId)!
    const ordered = Array.from({ length: g.n }, (_, i) => g.byK.get(i + 1))
    const complete = g.byK.size === g.n && ordered.every((m) => m !== undefined)
    if (complete) {
      const parts = ordered as T[]
      const rep = parts[0]!
      const body = parts.map((m) => parsePageHeader(m.body)!.chunk).join('')
      out.push({ ...rep, body, partIds: parts.map((m) => m.id) })
    } else {
      // Incomplete — pass each present part through as-is (header visible), in
      // k-order, so a partial group is surfaced rather than swallowed.
      const present = [...g.byK.keys()].sort((a, b) => a - b).map((k) => g.byK.get(k)!)
      for (const m of present) out.push({ ...m, partIds: [m.id] })
    }
  }
  return out
}

/**
 * Streaming reassembler for the watch surface, where messages arrive one at a
 * time. `offer()` returns a non-paginated message immediately; buffers a
 * paginated part and returns null until its group completes; then returns the
 * reassembled whole message (carrying every part id). Idempotent on duplicate
 * parts (deduped by k) and order-independent. The caller still marks each part
 * delivered as it arrives — `offer` only governs when to SURFACE the whole.
 */
export class PageReassembler<T extends { id: string; body: string } = { id: string; body: string }> {
  private groups = new Map<string, Map<number, T>>()

  offer(msg: T): (T & { partIds: string[] }) | null {
    const h = parsePageHeader(msg.body)
    if (!h) return { ...msg, partIds: [msg.id] }
    let byK = this.groups.get(h.groupId)
    if (!byK) {
      byK = new Map<number, T>()
      this.groups.set(h.groupId, byK)
    }
    if (!byK.has(h.k)) byK.set(h.k, msg)
    if (byK.size < h.n) return null
    const ordered: T[] = []
    for (let k = 1; k <= h.n; k++) {
      const part = byK.get(k)
      if (!part) return null // a gap remains — keep buffering
      ordered.push(part)
    }
    this.groups.delete(h.groupId)
    const rep = ordered[0]!
    const body = ordered.map((m) => parsePageHeader(m.body)!.chunk).join('')
    return { ...rep, body, partIds: ordered.map((m) => m.id) }
  }
}
