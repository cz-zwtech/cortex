/**
 * Self session-id resolution for manually-invoked CLIs / the watcher (hooks get
 * the authoritative id from their payload `input.session_id`).
 *
 * GROUND TRUTH is the transcript: the real id is the one whose `<id>.jsonl`
 * exists, is actively appended, and whose internal `sessionId` stamp matches the
 * filename. A continue/compact bootstrap mints a PHANTOM uuid that only ever gets
 * a `tool-results/` artifact dir + a blank presence — NEVER a transcript — so an
 * id sourced from such a path is never trusted. See the corrected memory
 * [[cortex-session-id-env-stale-after-compact]].
 */
import * as fsSync from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const HEAD_BYTES = 65536 // enough to find the first record carrying the sessionId stamp

const projectsRootDefault = (): string => path.join(os.homedir(), '.claude', 'projects')

interface Transcript {
  id: string
  filePath: string
  mtimeMs: number
}

/** Glob `<projectsRoot>/<encoded-cwd>/<uuid>.jsonl` — EXACTLY depth 2. A
 *  `tool-results/` artifact dir lives deeper, so phantom uuids are structurally
 *  excluded (they are never a depth-2 `<uuid>.jsonl`). Same-machine by nature. */
function scanTranscripts(projectsRoot: string): Transcript[] {
  const out: Transcript[] = []
  let dirs: string[]
  try {
    dirs = fsSync.readdirSync(projectsRoot)
  } catch {
    return out
  }
  for (const d of dirs) {
    const dir = path.join(projectsRoot, d)
    let files: string[]
    try {
      if (!fsSync.statSync(dir).isDirectory()) continue
      files = fsSync.readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      const m = /^([0-9a-f-]{36})\.jsonl$/i.exec(f)
      if (!m) continue
      try {
        const fp = path.join(dir, f)
        out.push({ id: m[1], filePath: fp, mtimeMs: fsSync.statSync(fp).mtimeMs })
      } catch {
        /* vanished — skip */
      }
    }
  }
  return out
}

/** Read the internal `sessionId` stamp from a transcript head. Returns null when
 *  no stamp is found / unreadable — which does NOT disqualify (don't penalize an
 *  unparsable head); only a stamp that MISMATCHES the filename disqualifies. */
function readStamp(filePath: string): string | null {
  let head: string
  try {
    const fd = fsSync.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(HEAD_BYTES)
      const n = fsSync.readSync(fd, buf, 0, HEAD_BYTES, 0)
      head = buf.toString('utf8', 0, n)
    } finally {
      fsSync.closeSync(fd)
    }
  } catch {
    return null
  }
  for (const line of head.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      const o = JSON.parse(s)
      if (typeof o.sessionId === 'string' && o.sessionId) return o.sessionId
    } catch {
      /* partial last line / non-JSON — keep scanning */
    }
  }
  return null
}

/** A transcript validates as identity `t.id` unless its readable stamp says
 *  otherwise (mismatched stamp ⇒ a copied/renamed transcript ⇒ NOT this id). */
function validates(t: Transcript): boolean {
  const stamp = readStamp(t.filePath)
  return stamp === null || stamp === t.id
}

/** The set of session ids that have a validated `<id>.jsonl` transcript on THIS
 *  host. The server uses this to tell a real (transcript-backed) presence from a
 *  bootstrap phantom (see reapPhantomPresences). Same-machine by construction. */
export function localTranscriptIds(projectsRoot?: string): Set<string> {
  return new Set(
    scanTranscripts(projectsRoot ?? projectsRootDefault())
      .filter(validates)
      .map((t) => t.id),
  )
}

export interface SelfIdOpts {
  explicit?: string | null // --session / --from (operator override)
  env?: string | null // CLAUDE_CODE_SESSION_ID
  input?: string | null // hook input.session_id
  projectsRoot?: string // injectable (tests); defaults to ~/.claude/projects
}

export interface SelfIdResult {
  sessionId: string | null
  source: 'explicit' | 'transcript' | 'env' | 'newest-transcript' | 'none'
}

/**
 * Resolve THIS session's id. The env (`CLAUDE_CODE_SESSION_ID`) / hook
 * `input.session_id` is RELIABLE and is trusted UNLESS the transcript
 * contradicts it (a continue/compact bootstrap never wrote a contradicting env —
 * the phantom came from an agent COPYING a tool-results uuid, which this never
 * sources). Ranking:
 *   0. explicit override (`--session`/`--from`) — verbatim.
 *   1. a candidate (env/input) whose `<id>.jsonl` exists + validates → newest of them.
 *   2. a candidate that is NOT contradicted (no `<id>.jsonl` with a MISMATCHED
 *      stamp) — verbatim. Covers a fresh session whose transcript hasn't flushed,
 *      and env+input agreement.
 *   3. newest validated transcript overall (no usable env/input).
 *   4. none.
 * Note: explicit/env/input are honored verbatim (any non-empty string — bus ids
 * are not always uuids); the `<uuid>.jsonl` shape gates only transcript FILES, so
 * a `tool-results/` artifact uuid is structurally never a candidate.
 */
export function resolveSelfSessionId(opts: SelfIdOpts = {}): SelfIdResult {
  const { explicit, env, input } = opts
  const projectsRoot = opts.projectsRoot ?? projectsRootDefault()

  if (explicit) return { sessionId: explicit, source: 'explicit' }

  const all = scanTranscripts(projectsRoot).map((t) => ({ t, ok: validates(t) }))
  const validated = all.filter((x) => x.ok).map((x) => x.t)
  const byId = new Map(validated.map((t) => [t.id, t]))
  const contradicted = new Set(all.filter((x) => !x.ok).map((x) => x.t.id))
  const newest = (ts: Transcript[]): Transcript | undefined =>
    ts.reduce<Transcript | undefined>((a, b) => (!a || b.mtimeMs > a.mtimeMs ? b : a), undefined)

  const candidates = [env, input].filter((c): c is string => !!c)

  // 1. candidate with its own validated transcript — newest of them.
  const cand = newest(candidates.map((c) => byId.get(c)).filter((t): t is Transcript => !!t))
  if (cand) return { sessionId: cand.id, source: 'transcript' }

  // 2. trust an uncontradicted candidate verbatim (fresh session / agreement).
  const trusted = candidates.find((c) => !contradicted.has(c))
  if (trusted) return { sessionId: trusted, source: 'env' }

  // 3. newest validated transcript overall.
  const any = newest(validated)
  if (any) return { sessionId: any.id, source: 'newest-transcript' }

  return { sessionId: null, source: 'none' }
}

/**
 * Encode a filesystem path the way Claude Code names its `~/.claude/projects/`
 * dirs. SINGLE SOURCE OF TRUTH for the transcript-resolution path. Legacy
 * storage-KEY encoders (graph ids/scopes, pattern files, write-dirs) keep their
 * own byte-identical local copies on purpose — rekeying existing nodes would be
 * a behavior change, and those sites don't resolve a transcript.
 */
export const encodeProjectPath = (p: string): string => p.replace(/[/\\:]/g, '-')

/**
 * The project dir for a cwd when NO session id is known — the pre-transcript
 * write-path heuristic. Walk DEEPEST-FIRST from cwd up its ancestors and return
 * the first whose `<projectsRoot>/<enc>` dir already exists (most-specific root
 * wins, deterministically: a subdir beats its parent when both exist). Falls
 * back to encoding the raw cwd when no ancestor dir exists (a brand-new project;
 * a later mkdir by the caller creates it).
 */
export function projectDirForCwd(cwd: string, projectsRoot?: string): string {
  const root = projectsRoot ?? projectsRootDefault()
  let p = cwd
  while (p && p !== '/' && p.length > 1) {
    const dir = path.join(root, encodeProjectPath(p))
    try {
      if (fsSync.statSync(dir).isDirectory()) return dir
    } catch {
      /* not this ancestor — keep walking up */
    }
    const i = p.lastIndexOf('/')
    if (i <= 0) break
    p = p.slice(0, i)
  }
  return path.join(root, encodeProjectPath(cwd))
}

/**
 * Canonical resolver for the project dir that holds a session's transcript —
 * the cure for the hand-rolled-`encode(cwd)` bug (see file header). Ordered:
 *   1. glob-by-sid: the dir that actually CONTAINS `<sessionId>.jsonl`,
 *      AUTHORITATIVE — beats any same-named encoded-cwd dir (the subdir-cwd
 *      repro). Reuses scanTranscripts (the enumeration resolveSelfSessionId
 *      uses), so it is same-machine + phantom-excluded by construction.
 *   2. no transcript yet → projectDirForCwd (deepest existing ancestor dir).
 *   3. raw-encode the cwd (folded into projectDirForCwd's fallback).
 * Transcript-resolution sites derive `<sid>.jsonl` / `memory/` from this dir
 * instead of trusting `encode(cwd)`.
 */
export function projectDirForSession(sessionId: string, cwd: string, projectsRoot?: string): string {
  const root = projectsRoot ?? projectsRootDefault()
  for (const t of scanTranscripts(root)) {
    if (t.id === sessionId) return path.dirname(t.filePath)
  }
  return projectDirForCwd(cwd, root)
}

/**
 * Back-compat shim: the "current" session id for a cwd. Prefer
 * `resolveSelfSessionId` (transcript-first, globs all dirs, validates stamps).
 * This narrower form is kept for callers that only have a cwd: newest validated
 * transcript under that cwd's project dir, else the global transcript resolver.
 */
export const resolveCurrentSession = async (cwd: string): Promise<string | null> => {
  const dir = projectDirForCwd(cwd)
  try {
    const local = fsSync
      .readdirSync(dir)
      .map((f) => /^([0-9a-f-]{36})\.jsonl$/i.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ id: m[1], mtimeMs: fsSync.statSync(path.join(dir, m[0])).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    if (local[0]) return local[0].id
  } catch {
    /* fall through to the global resolver */
  }
  return resolveSelfSessionId().sessionId
}
