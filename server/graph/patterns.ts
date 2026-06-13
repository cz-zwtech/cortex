/**
 * Fail→success pattern extraction.
 *
 * A "pattern" is a tool call that errored followed by a later call of the
 * same tool that succeeded — Claude figured out a fix on its own. Capturing
 * these as graph nodes lets future sessions skip the trial-and-error: when
 * a tool errors, the recall hook surfaces matching patterns and Claude can
 * jump straight to the known-good shape.
 *
 * Detection rules:
 *   1. A `tool_use(X)` whose matching `tool_result(X)` has `is_error: true`.
 *   2. A later `tool_use(X')` of the *same tool name* (different id), within
 *      a 10-minute window, whose matching `tool_result(X')` is success.
 *   3. The fail→success pair becomes a pattern Entry with stable id
 *      `pattern:<projectDir>/<sessionId>/<failToolUseId>` so re-runs are
 *      idempotent.
 *
 * Caveats:
 *   - "Same tool name" is the only similarity check. We don't try to match
 *     args yet — the LLM-side semantic match in the recall hook does that.
 *   - First success after a fail wins; subsequent successes don't create
 *     additional patterns. Keeps the graph from blooming with redundant
 *     entries when Claude tries 3 variations and the third works.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { all, get, run, transaction } from './db.js'
import { embedText, embeddingTextForEntry, getEmbeddingMode } from '../embeddings.js'
import { putEmbedding, searchSimilar } from '../embeddingStore.js'
import type { ParsedLine } from '../sessions.js'

const TEN_MINUTES_MS = 10 * 60 * 1000

export interface PatternCandidate {
  id: string
  projectDir: string
  sessionId: string
  tool: string
  failToolUseId: string
  successToolUseId: string
  failArgs: string
  successArgs: string
  errorMessage: string
  failTimestamp: string
  successTimestamp: string
}

/**
 * Build the needle for a faithful substring `lower(col) LIKE '%'||?||'%'`
 * match (blueprint §1.8 v1). Lowercases (parity with the case-insensitive
 * LIKE path) and escapes LIKE metacharacters so a tool name containing `%`,
 * `_`, or `\` matches literally — preserving substring (CONTAINS) semantics. The
 * queries that use this MUST add `ESCAPE '\'`.
 */
const likeContains = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')

/**
 * Extract fail→success pairs from a session's parsed-line stream. Returns
 * candidates in chronological order. The caller is responsible for
 * upserting; we only describe what to write.
 */
export const extractPatterns = (
  projectDir: string,
  sessionId: string,
  lines: ParsedLine[],
): PatternCandidate[] => {
  // Build a tool_use → tool_result correlation. tool_use rows are emitted
  // first; results may appear several lines later (the user-message that
  // carries them lands after the assistant's tool calls). Walk the whole
  // stream in order and match by id.
  const calls = new Map<
    string,
    { tool: string; args: string; ts: string; line: number; lineSeq: number }
  >()
  // Lookup by tool_use id.
  // Result is recorded against its toolUseId.
  const results = new Map<
    string,
    { isError: boolean; text: string; ts: string }
  >()
  let seq = 0
  for (const l of lines) {
    if (l.type === 'tool_use' && l.tool && l.toolUseId) {
      calls.set(l.toolUseId, {
        tool: l.tool,
        args: l.text ?? '',
        ts: l.timestamp,
        line: l.line,
        lineSeq: seq,
      })
    } else if (l.type === 'tool_result' && l.toolUseId) {
      results.set(l.toolUseId, {
        isError: !!l.isError,
        text: l.text ?? '',
        ts: l.timestamp,
      })
    }
    seq++
  }

  // Resolve correlated calls into chronological order with status.
  const correlated: Array<{
    id: string
    tool: string
    args: string
    isError: boolean
    errorText: string
    callTs: string
    resultTs: string
    lineSeq: number
  }> = []
  for (const [id, call] of calls) {
    const res = results.get(id)
    if (!res) continue
    correlated.push({
      id,
      tool: call.tool,
      args: call.args,
      isError: res.isError,
      errorText: res.text,
      callTs: call.ts,
      resultTs: res.ts,
      lineSeq: call.lineSeq,
    })
  }
  correlated.sort((a, b) => a.lineSeq - b.lineSeq)

  // Walk: for each error, find the next success for the same tool within
  // the time window. Mark used pairs so a single fail doesn't pair with
  // multiple successes.
  const candidates: PatternCandidate[] = []
  const consumedSuccessIds = new Set<string>()
  for (let i = 0; i < correlated.length; i++) {
    const fail = correlated[i]!
    if (!fail.isError) continue

    const failMs = Date.parse(fail.callTs || fail.resultTs || '')
    if (Number.isNaN(failMs)) continue

    let next: typeof correlated[number] | null = null
    for (let j = i + 1; j < correlated.length; j++) {
      const cand = correlated[j]!
      if (cand.tool !== fail.tool) continue
      if (cand.isError) continue
      if (consumedSuccessIds.has(cand.id)) continue
      const okMs = Date.parse(cand.callTs || cand.resultTs || '')
      if (Number.isNaN(okMs)) continue
      if (okMs - failMs > TEN_MINUTES_MS) break
      next = cand
      break
    }
    if (!next) continue
    consumedSuccessIds.add(next.id)

    candidates.push({
      id: `pattern:${projectDir}/${sessionId}/${fail.id}`,
      projectDir,
      sessionId,
      tool: fail.tool,
      failToolUseId: fail.id,
      successToolUseId: next.id,
      failArgs: fail.args,
      successArgs: next.args,
      errorMessage: fail.errorText.slice(0, 400),
      failTimestamp: fail.callTs || fail.resultTs,
      successTimestamp: next.callTs || next.resultTs,
    })
  }
  return candidates
}

/**
 * Build the human-readable name + description + content for a pattern.
 * Templated, not LLM-generated — keep it deterministic. The recall hook
 * will paste the content verbatim into Claude's context so the format
 * matters.
 */
export const renderPattern = (c: PatternCandidate): {
  name: string
  description: string
  content: string
} => {
  const errorSummary = summariseError(c.errorMessage)
  const name = `${c.tool}: ${errorSummary}`.slice(0, 80)
  const description = `${c.tool}(${truncate(c.failArgs, 40)}) → fails (${errorSummary}); succeeds with ${c.tool}(${truncate(c.successArgs, 40)})`.slice(
    0,
    240,
  )
  const content = [
    `# Pattern · ${c.tool}`,
    '',
    `When a \`${c.tool}\` call shaped like:`,
    '',
    '```',
    `${c.tool}(${c.failArgs})`,
    '```',
    '',
    `fails with:`,
    '',
    '```',
    c.errorMessage || '(no error text captured)',
    '```',
    '',
    `…the fix that worked in this session was:`,
    '',
    '```',
    `${c.tool}(${c.successArgs})`,
    '```',
    '',
    `_Captured from session \`${c.sessionId}\` in project \`${c.projectDir}\` on ${c.successTimestamp}._`,
  ].join('\n')
  return { name, description, content }
}

const truncate = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1) + '…' : s

/**
 * Best-effort summary of an error message — keeps the pattern name short
 * and readable. Common failure modes get a tiny canned phrasing; everything
 * else falls back to the first ~50 characters.
 */
const summariseError = (msg: string): string => {
  if (!msg) return 'failed'
  const m = msg.toLowerCase()
  if (m.includes('permission denied')) return 'permission denied'
  if (m.includes('command not found')) return 'command not found'
  if (m.includes('no such file') || m.includes('enoent')) return 'no such file'
  if (m.includes('eacces')) return 'permission denied (eacces)'
  if (m.includes('connection refused') || m.includes('econnrefused')) return 'connection refused'
  if (m.includes('timeout') || m.includes('etimedout')) return 'timeout'
  if (m.includes('not authorized') || m.includes('401') || m.includes('403')) return 'unauthorized'
  if (m.includes('rate limit') || m.includes('429')) return 'rate limited'
  if (m.includes('syntax error')) return 'syntax error'
  if (m.includes('parse error')) return 'parse error'
  if (m.includes('invalid argument')) return 'invalid argument'
  // Strip leading whitespace + take first phrase.
  const trimmed = msg.trim().split(/[.\n]/, 1)[0] ?? msg
  return truncate(trimmed, 50)
}

/**
 * Compute a fingerprint for a pattern based on its semantic content —
 * tool + summarised error + first chunk of fail-args + first chunk of
 * success-args. Patterns sharing this fingerprint represent the same
 * lesson even when captured across different sessions.
 *
 * We do a fast string hash (FNV-1a 32-bit) so the fingerprint fits in a
 * stable string we can index on. Collisions are tolerable here — a false
 * dedupe just means one extra pattern shows up.
 */
export const patternFingerprint = (c: PatternCandidate): string => {
  const errorSummary = summariseError(c.errorMessage)
  const fa = (c.failArgs ?? '').slice(0, 60)
  const sa = (c.successArgs ?? '').slice(0, 60)
  const seed = `${c.tool}|${errorSummary}|${fa}|${sa}`
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ── disk persistence ────────────────────────────────────────────────────────

const conceptSlug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * Encode a project directory path the same way Claude Code does for
 * `~/.claude/projects/`. Patterns store the original `projectDir` (an
 * unencoded filesystem path) so we encode it here when picking the
 * memory-dir target.
 */
const encodeProjectDir = (projectDir: string): string =>
  projectDir.replace(/[/\\:]/g, '-')

/**
 * Write a `pattern-<fp>.md` file under the project's memory dir. The file
 * is the durable record — the graph node exists as a fast index over it.
 * If the file is removed, sync rebuilds the node from disk; if the DB is
 * deleted, sync rebuilds every pattern node from these files.
 *
 * Returns the absolute path that was written. Idempotent — overwriting
 * with identical content is fine.
 */
export const writePatternMd = async (c: PatternCandidate): Promise<string> => {
  const fingerprint = patternFingerprint(c)
  const encProj = encodeProjectDir(c.projectDir)
  const memDir = path.join(os.homedir(), '.claude', 'projects', encProj, 'memory')
  const file = path.join(memDir, `pattern-${fingerprint}.md`)
  const stableId = `${encProj}/pattern-${fingerprint}`

  const { name, description, content } = renderPattern(c)
  const taggedDescription = `[fp:${fingerprint}] ${description}`

  const frontmatter = [
    '---',
    `id: ${stableId}`,
    `name: ${yamlString(name)}`,
    `description: ${yamlString(taggedDescription)}`,
    `type: pattern`,
    `scope: pattern:auto`,
    // Authorship + outcome — see docs/reference/graph-schema.md. Patterns are
    // always auto-extracted from session JSONLs; outcome is 'success'
    // because a pattern only exists when a fail→success was observed.
    `authorship: auto-extracted`,
    `outcome: success`,
    `outcome_text: ${yamlString((c.successArgs ?? '').slice(0, 500))}`,
    `session_id: ${c.sessionId}`,
    // Typed-edge frontmatter — sync materializes MENTIONS_TOOL.
    `mentions_tools: [${yamlString(c.tool)}]`,
    // Pattern-specific structured fields (Pattern specialization table).
    `fingerprint: ${fingerprint}`,
    `tool: ${yamlString(c.tool)}`,
    `project_dir: ${yamlString(c.projectDir)}`,
    `fail_timestamp: ${yamlString(c.failTimestamp)}`,
    `success_timestamp: ${yamlString(c.successTimestamp)}`,
    '---',
    '',
    content,
    '',
  ].join('\n')

  await fsp.mkdir(memDir, { recursive: true })
  await fsp.writeFile(file, frontmatter, 'utf-8')
  return file
}

/**
 * Write a `concept-<slug>.md` for a tool concept node. Lives at
 * `~/.claude/memory/concepts/` so it's user-wide (concepts span projects)
 * and visually segregated from human-written memory.
 */
export const writeConceptMd = async (
  toolName: string,
): Promise<{ file: string; id: string; slug: string }> => {
  const slug = conceptSlug(toolName)
  const id = `concept:${slug}`
  const dir = path.join(os.homedir(), '.claude', 'memory', 'concepts')
  const file = path.join(dir, `concept-${slug}.md`)

  const body = [
    '---',
    `id: ${id}`,
    `name: ${yamlString(toolName)}`,
    `description: ${yamlString(`Tool: ${toolName}`)}`,
    `type: concept`,
    `scope: tool`,
    `authorship: auto-extracted`,
    '---',
    '',
    `# ${toolName}`,
    '',
    `Auto-generated concept node for the \`${toolName}\` tool. Patterns and shared-mind memories that reference this tool link to this entry, so the recall hook can hop tool-name → patterns when the same tool errors again.`,
    '',
  ].join('\n')

  await fsp.mkdir(dir, { recursive: true })
  // Idempotent write — if the file already exists with identical content,
  // this is a no-op at the byte level.
  await fsp.writeFile(file, body, 'utf-8')
  return { file, id, slug }
}

/**
 * Minimal YAML string escaper: quote when the value contains a colon, a
 * quote, or starts with whitespace; otherwise emit bare.
 */
const yamlString = (raw: string): string => {
  const s = String(raw ?? '')
  if (!s) return '""'
  if (/^[\w/.\-+]+$/.test(s)) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/**
 * Upsert a pattern. Writes a `pattern-<fp>.md` file as the durable
 * record, then mirrors the entry into the graph as a fast index. The file
 * lives at `~/.claude/projects/<encoded-projectDir>/memory/`, so a
 * subsequent `npm run sync` over a wiped graph.db rebuilds every
 * pattern node from disk.
 *
 * Skipped if a semantically-equivalent pattern (same fingerprint) already
 * exists — dedupes "Bash: Exit code 144" across sessions. Returns true
 * if a new entry actually landed.
 */
export const upsertPattern = async (c: PatternCandidate): Promise<boolean> => {
  const fingerprint = patternFingerprint(c)
  // Semantic dedup — bail before any writes if a pattern with the same
  // fingerprint already exists from any session. Same lesson; no need
  // for a duplicate entry. STARTS WITH '[fp:<fp>]' → LIKE '[fp:<fp>]%'.
  const sameFp = get<{ id: string }>(
    `SELECT id FROM entries WHERE kind = 'pattern' AND description LIKE ? LIMIT 1`,
    `[fp:${fingerprint}]%`,
  )
  if (sameFp) {
    return false
  }

  // Disk write first — this is the source of truth.
  const file = await writePatternMd(c)

  const stableId = `${encodeProjectDir(c.projectDir)}/pattern-${fingerprint}`
  const existing = get<{ id: string }>(`SELECT id FROM entries WHERE id = ? LIMIT 1`, stableId)
  const isNew = !existing

  const { name, description, content } = renderPattern(c)
  const now = Date.now()
  // Prefix description with the fingerprint so future calls can dedupe
  // by string match without a separate column.
  const tagged = `[fp:${fingerprint}] ${description}`
  // updatedAt = when the success happened; it's the moment the pattern
  // actually became real.
  const successMs = Date.parse(c.successTimestamp) || now

  // Edge: pattern → tool concept node. Lets the graph view cluster patterns
  // by tool, and recall queries can hop tool-name → patterns. Concept
  // also gets backed by an .md file so it's part of the rebuildable set.
  // (FS write outside the transaction — the .md is the rebuildable record.)
  const { id: tcid } = await writeConceptMd(c.tool)
  const conceptSource = path.join(
    os.homedir(),
    '.claude',
    'memory',
    'concepts',
    `concept-${conceptSlug(c.tool)}.md`,
  )

  // All graph mutations land atomically: the entry rewrite (DETACH DELETE +
  // CREATE), the Pattern specialization (pattern_meta), the tool-concept stub,
  // and the LINKS_TO edge. better-sqlite3 statements are synchronous so this
  // whole block runs without interleaving.
  transaction(() => {
    // DETACH DELETE e (drop incident edges, then the node) + CREATE (:Entry {...})
    run(`DELETE FROM edges WHERE src = ? OR dst = ?`, stableId, stableId)
    run(`DELETE FROM entries WHERE id = ?`, stableId)
    run(
      `INSERT INTO entries ` +
        `(id, name, kind, description, content, source, scope, updatedAt, syncedAt, ` +
        ` authorship, outcome, outcome_text, agent_id, session_id) ` +
        // Patterns are always auto-extracted — fail→success detection lives
        // in the watcher. Outcome is implicit ('success' — we only record
        // patterns where a fix worked) and outcome_text carries the verbatim
        // success args so the recall hook can show ground truth.
        `VALUES (?, ?, 'pattern', ?, ?, ?, 'pattern:auto', ?, ?, 'auto-extracted', 'success', ?, '', ?)`,
      stableId,
      name,
      tagged,
      content,
      file,
      successMs,
      now,
      (c.successArgs ?? '').slice(0, 1000),
      c.sessionId ?? '',
    )

    // Pattern specialization row — same id, structured fields. The id-joined
    // pattern_meta table is always present (initSchema), so the old "Pattern
    // table may be missing" guard is gone.
    run(`DELETE FROM pattern_meta WHERE id = ?`, stableId)
    run(
      `INSERT INTO pattern_meta (id, tool, fail_args, success_args, error_text, fingerprint) ` +
        `VALUES (?, ?, ?, ?, ?, ?)`,
      stableId,
      c.tool,
      (c.failArgs ?? '').slice(0, 2000),
      (c.successArgs ?? '').slice(0, 2000),
      (c.errorMessage ?? '').slice(0, 2000),
      fingerprint,
    )

    // Tool concept stub — created once, idempotent on id.
    const tcExists = get<{ id: string }>(`SELECT id FROM entries WHERE id = ? LIMIT 1`, tcid)
    if (!tcExists) {
      run(
        `INSERT INTO entries ` +
          `(id, name, kind, description, content, source, scope, updatedAt, syncedAt) ` +
          `VALUES (?, ?, 'concept', ?, '', ?, 'tool', ?, ?)`,
        tcid,
        c.tool,
        `Tool: ${c.tool}`,
        conceptSource,
        now,
        now,
      )
    }

    // Idempotent edge: pattern -[LINKS_TO {label:'tool'}]-> tool concept.
    // Composite PK (src,dst,rel) makes INSERT OR IGNORE the idempotent CREATE.
    run(
      `INSERT OR IGNORE INTO edges (src, dst, rel, label) VALUES (?, ?, 'LINKS_TO', 'tool')`,
      stableId,
      tcid,
    )
  })

  // Embed the pattern text. Best-effort — semantic recall is an
  // enhancement layer; substring search continues to find this
  // pattern even if embedding fails or is disabled. Done outside the
  // transaction: embedding is an async sidecar write, not graph state.
  if (getEmbeddingMode() !== 'off') {
    try {
      const text = embeddingTextForEntry({ name, description: tagged, content })
      const vec = await embedText(text)
      if (vec) await putEmbedding(stableId, vec)
    } catch {
      // best-effort
    }
  }

  return isNew
}

export interface RecallHit {
  id: string
  name: string
  description: string
  content: string
  syncedAt: number
  /** Source bucket — drives rendering tone in the recall hook output. */
  source: 'pattern' | 'shared'
}

/**
 * Search patterns for a tool. Returns most-recent first. The recall hook
 * uses this to surface similar past failures to Claude when a tool errors.
 *
 * When embeddings are enabled, this also runs a semantic top-K search
 * over pattern entries and merges the results — so a pattern about
 * "sleep blocked by approval" surfaces even when the keyword search
 * for the tool name doesn't match the user's current error verbatim.
 * Substring matches stay as the floor; semantic adds breadth.
 */
export const searchPatterns = async (
  tool: string,
  limit = 5,
  semanticQuery?: string,
): Promise<RecallHit[]> => {
  // `name CONTAINS tool` → faithful substring via lower() LIKE (blueprint
  // §1.8 v1 path). Bound param, escaped LIKE wildcards.
  const rows = all<{
    id: string
    name: string
    description: string
    content: string
    syncedAt: number | bigint
  }>(
    `SELECT id, name, description, content, syncedAt FROM entries ` +
      `WHERE kind = 'pattern' AND lower(name) LIKE '%' || ? || '%' ESCAPE '\\' ` +
      `ORDER BY syncedAt DESC LIMIT ?`,
    likeContains(tool),
    limit,
  )
  const keyword: RecallHit[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    content: r.content,
    syncedAt: Number(r.syncedAt),
    source: 'pattern' as const,
  }))

  // Augment with semantic hits when embeddings are available. The
  // semantic query is the keyword search's input by default, but the
  // caller can pass a richer query (e.g. the actual error text) for
  // better cosine matches.
  const semantic = await semanticPatternHits(semanticQuery ?? tool, limit)
  return mergeHits(keyword, semantic, limit)
}

/**
 * Vector top-K over pattern entries. Embeds the query, scans the
 * sidecar, hydrates the matching entries from the graph. Returns [] when
 * embeddings are disabled or the model is unavailable.
 */
const semanticPatternHits = async (
  query: string,
  limit: number,
): Promise<RecallHit[]> => {
  if (getEmbeddingMode() === 'off') return []
  const queryVec = await embedText(query)
  if (!queryVec) return []
  // Pull a wider candidate window from the embedding store so we can
  // filter to pattern-only afterwards. 4× the requested limit gives us
  // headroom when patterns aren't the densest entries in the store.
  const candidates = await searchSimilar(queryVec, limit * 4, 0.35)
  if (candidates.length === 0) return []
  const ids = candidates.map((c) => c.id)
  const placeholders = ids.map(() => '?').join(', ')
  const rows = all<{
    id: string
    name: string
    description: string
    content: string
    syncedAt: number | bigint
  }>(
    `SELECT id, name, description, content, syncedAt FROM entries ` +
      `WHERE kind = 'pattern' AND id IN (${placeholders})`,
    ...ids,
  )
  // Re-rank by candidate score (cosine), preserve top `limit`.
  const scoreById = new Map(candidates.map((c) => [c.id, c.score]))
  rows.sort((a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0))
  return rows.slice(0, limit).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    content: r.content,
    syncedAt: Number(r.syncedAt),
    source: 'pattern' as const,
  }))
}

/** Merge two RecallHit lists, dedup by id, keep the union's top `limit`. */
const mergeHits = (a: RecallHit[], b: RecallHit[], limit: number): RecallHit[] => {
  const seen = new Set<string>()
  const out: RecallHit[] = []
  for (const hit of [...a, ...b]) {
    if (seen.has(hit.id)) continue
    seen.add(hit.id)
    out.push(hit)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Search shared-mind memories for a tool. Returns memories from any
 * `shared:*` scope whose name, description, or content references the
 * tool — typically Corey's notes about how he uses Bash for SSH, or a
 * memory describing an MCP that exposes the tool.
 *
 * The awareness model: surface what other users *know* about this tool,
 * even if the local user hasn't installed their version. Claude reads,
 * the local user decides.
 */
export const searchSharedKnowledge = async (
  tool: string,
  limit = 5,
  semanticQuery?: string,
): Promise<RecallHit[]> => {
  // scope STARTS WITH 'shared:' → scope LIKE 'shared:%'; the name/description/
  // content CONTAINS triple → lower() LIKE on each (blueprint §1.8 faithful).
  const needle = likeContains(tool)
  const rows = all<{
    id: string
    name: string
    description: string
    content: string
    syncedAt: number | bigint
  }>(
    `SELECT id, name, description, content, syncedAt FROM entries ` +
      `WHERE scope LIKE 'shared:%' ` +
      `  AND (lower(name) LIKE '%' || ? || '%' ESCAPE '\\' ` +
      `   OR lower(description) LIKE '%' || ? || '%' ESCAPE '\\' ` +
      `   OR lower(content) LIKE '%' || ? || '%' ESCAPE '\\') ` +
      `ORDER BY syncedAt DESC LIMIT ?`,
    needle,
    needle,
    needle,
    limit,
  )
  const keyword: RecallHit[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    content: r.content,
    syncedAt: Number(r.syncedAt),
    source: 'shared' as const,
  }))

  const semantic = await semanticSharedHits(semanticQuery ?? tool, limit)
  return mergeHits(keyword, semantic, limit)
}

const semanticSharedHits = async (
  query: string,
  limit: number,
): Promise<RecallHit[]> => {
  if (getEmbeddingMode() === 'off') return []
  const queryVec = await embedText(query)
  if (!queryVec) return []
  const candidates = await searchSimilar(queryVec, limit * 4, 0.35)
  if (candidates.length === 0) return []
  const ids = candidates.map((c) => c.id)
  const placeholders = ids.map(() => '?').join(', ')
  const rows = all<{
    id: string
    name: string
    description: string
    content: string
    syncedAt: number | bigint
  }>(
    `SELECT id, name, description, content, syncedAt FROM entries ` +
      `WHERE scope LIKE 'shared:%' AND id IN (${placeholders})`,
    ...ids,
  )
  const scoreById = new Map(candidates.map((c) => [c.id, c.score]))
  rows.sort((a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0))
  return rows.slice(0, limit).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    content: r.content,
    syncedAt: Number(r.syncedAt),
    source: 'shared' as const,
  }))
}
