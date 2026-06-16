import { Router } from 'express'
import { graphRecall, type RecallHit } from '../graph/recall.js'
import { recordSurface } from '../usageScores.js'
import { recordSurfacings } from '../graph/surfacings.js'
import { ancestorProjectScopes } from '../graph/projectScopes.js'

export const recallRouter = Router()

/**
 * POST /api/recall — body { tool: string, args?: string, errorMessage?: string }
 *
 * Returns two buckets of memory hits:
 *   - patterns: kind:'pattern' entries (fail→success traces from prior sessions)
 *   - shared:   scope:'shared:*' memories
 *
 * Phase 4: ranking comes from `graphRecall` — vector seeds + 1-hop
 * traversal across :RESOLVES, :MENTIONS_FILE, :MENTIONS_TOOL,
 * :OCCURRED_IN, :CONTRADICTS, :EVOLVED_INTO + JS-side rescore. The
 * response shape stays {patterns, shared} so the existing recall hook
 * keeps working unchanged. We just split graphRecall's combined output
 * into the two buckets the hook expects.
 *
 * Each returned hit also carries a `signals` field (cosine, hops,
 * viaEdge, recency, composite) so the UI / future debugging can see
 * WHY a memory surfaced.
 */
/**
 * Parse a relative-time shorthand into a ms epoch lower bound.
 * Accepts forms like "7d", "24h", "30m", "2w", "90s". Returns null on
 * malformed input so the caller can ignore it without throwing.
 */
const parseRelativeSince = (s: string): number | null => {
  const m = /^(\d+)\s*([smhdw])$/.exec(s.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2]!
  const ms =
    unit === 's' ? n * 1000 :
    unit === 'm' ? n * 60_000 :
    unit === 'h' ? n * 3_600_000 :
    unit === 'd' ? n * 86_400_000 :
    /* w */          n * 7 * 86_400_000
  return Date.now() - ms
}

const parseTimestamp = (s: unknown): number | undefined => {
  if (typeof s !== 'string') return undefined
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : undefined
}

recallRouter.post('/', async (req, res) => {
  const { tool, args, errorMessage, since, until, since_relative, sessionId, cwd } = (req.body ?? {}) as {
    tool?: string
    args?: string
    errorMessage?: string
    since?: string
    until?: string
    since_relative?: string
    sessionId?: string
    cwd?: string
  }
  if (!tool || typeof tool !== 'string') {
    return res.status(400).json({ error: 'tool required' })
  }

  // Time bounds: explicit ISO `since`/`until` win; `since_relative` is a
  // shorthand ("7d", "24h"). Either / both / neither — no requirement.
  const sinceMs = parseTimestamp(since) ??
    (typeof since_relative === 'string' ? parseRelativeSince(since_relative) ?? undefined : undefined)
  const untilMs = parseTimestamp(until)

  // Build a query that combines tool + args + error so cosine has
  // semantic substance, not just a tool name. Files referenced in args
  // get extracted for :MENTIONS_FILE traversal.
  const filePathRegex =
    /(?:^|[\s"'`(\[])((?:\.{0,2}\/|[a-zA-Z]:[\\/]|~\/)[^\s"'`)\]]+\.(?:ts|tsx|js|jsx|json|md|py|sh|sql|yaml|yml|toml|css|html))/g
  const files: string[] = []
  if (args) {
    let m: RegExpExecArray | null
    while ((m = filePathRegex.exec(args)) !== null) files.push(m[1]!)
  }

  const query = [errorMessage ?? '', args ?? '', `tool:${tool}`]
    .filter(Boolean)
    .join(' ')
    .slice(0, 800)

  try {
    // Pull a wider window than we'll return — graphRecall's typed-
    // edge expansion can surface non-pattern, non-shared rows that
    // get filtered out at the bucketing stage.
    const all = await graphRecall({
      query,
      tool,
      errorText: errorMessage,
      files: files.length > 0 ? files : undefined,
      limit: 25,
      since: sinceMs ?? undefined,
      until: untilMs ?? undefined,
      // now-slice: cwd → ancestor project scopes feed the soft scope prior in
      // graphRecall (a ranking nudge, never a filter).
      scopes: cwd ? ancestorProjectScopes(cwd) : undefined,
    })

    // Split into response buckets. Cap each at 5 to keep the injected
    // context reasonable; composite-sorted ordering is preserved from
    // graphRecall's output.
    //   - patterns    : fail→success traces from prior sessions
    //   - shared      : team-published (scope shared:*) memories
    //   - operational : the user's OWN native-scope memories that describe
    //                   how to correctly operate this tool/system. These
    //                   were already retrieved + scored by graphRecall but
    //                   previously discarded at bucketing. Gated on a direct
    //                   semantic match (or a pinned memory) so the proactive
    //                   awareness path stays precise — we don't want every
    //                   tool call dragging in loosely-related memories.
    const patterns: RecallHit[] = []
    const shared: RecallHit[] = []
    const operational: RecallHit[] = []
    const OPERATIONAL_MIN_COSINE = 0.45
    for (const hit of all) {
      if (hit.source === 'pattern' && patterns.length < 5) patterns.push(hit)
      else if (hit.source === 'shared' && shared.length < 5) shared.push(hit)
      else if (
        hit.source === 'memory' &&
        operational.length < 5 &&
        (hit.signals.cosine != null && hit.signals.cosine >= OPERATIONAL_MIN_COSINE)
      ) {
        operational.push(hit)
      }
    }

    // Phase 5: every hit returned counts as a surface — record it so
    // graphRecall can use historical surface counts to bias future
    // ranking. Positive-only signal per the design call (no decay,
    // no penalty for unused entries).
    const allHitIds = [...patterns, ...shared, ...operational].map((h) => h.id)
    void recordSurface(allHitIds)
    // s1: graph-backed surfacings log — record SURFACED_IN (memory→session) so s3
    // can correlate surfaced↔acted-on and s4 can decay never-used memories. Needs
    // the caller's sessionId; a UI / older hook without it no-ops gracefully.
    if (sessionId) recordSurfacings(String(sessionId), allHitIds, Date.now())

    // Backwards-compat shape: the existing recall hook reads
    // {patterns, shared}; `operational` is additive — older hooks ignore it.
    res.json({ patterns, shared, operational })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})
