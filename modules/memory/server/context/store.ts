/**
 * The context store: dialogue blocks captured from session transcripts.
 *
 * Its own SQLite file in the memory module's data dir (private mind design,
 * section 4.1), apart from the graph: blocks are many and grow forever, and
 * nothing in recall should pay for them until it asks.
 *
 * A block is one turn of dialogue, keyed (machine, session, key). Parts are
 * applied once each by their line uuid, so reading a transcript twice, or a
 * capture stopping half-way through a message, never duplicates text.
 * Every part is secret-scanned before it is stored: the store never holds a
 * raw credential, even one a person pasted into a chat.
 */
import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

import { scanForSecrets } from '../../../../core/secrets.js'
import { HEAT, heatNow } from './depth.js'
import type { BlockPart, SessionMeta } from './transcript.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  machine TEXT NOT NULL, session TEXT NOT NULL,
  parent TEXT, agent TEXT, cwd TEXT, branch TEXT, version TEXT, title TEXT, entrypoint TEXT,
  first_at INTEGER, last_at INTEGER,
  PRIMARY KEY (machine, session));
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY,
  machine TEXT NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL, key TEXT NOT NULL,
  speaker TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, boundary INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'transcript', party TEXT,
  UNIQUE (machine, session, key));
CREATE INDEX IF NOT EXISTS blocks_by_seq ON blocks (machine, session, seq);
CREATE TABLE IF NOT EXISTS block_parts (
  machine TEXT NOT NULL, session TEXT NOT NULL, uuid TEXT NOT NULL,
  PRIMARY KEY (machine, session, uuid));
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(text, content='blocks', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS blocks_ai AFTER INSERT ON blocks BEGIN
  INSERT INTO blocks_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER IF NOT EXISTS blocks_au AFTER UPDATE OF text ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO blocks_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TABLE IF NOT EXISTS anchors (
  source TEXT NOT NULL,               -- the memory file written: how a memory finds its anchors
  at INTEGER NOT NULL,                -- when it was written
  machine TEXT NOT NULL, session TEXT NOT NULL,
  seq_from INTEGER NOT NULL, seq_to INTEGER NOT NULL,
  how TEXT NOT NULL,                  -- 'capture' | 'backfill'
  PRIMARY KEY (machine, session, source, at));
CREATE INDEX IF NOT EXISTS anchors_by_source ON anchors (source);
CREATE TABLE IF NOT EXISTS heat (
  target TEXT NOT NULL, kind TEXT NOT NULL,   -- a block id or a memory id; 'block' | 'memory'
  score REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0, related INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL,
  PRIMARY KEY (target, kind));
CREATE TABLE IF NOT EXISTS pulls (            -- every dialogue window recall added, why, and how it was used
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, session TEXT, query TEXT NOT NULL,
  blocks TEXT NOT NULL,                       -- JSON block ids
  quality TEXT NOT NULL DEFAULT 'related');   -- 'related' | 'used'
CREATE TABLE IF NOT EXISTS spans (           -- contiguous block ranges of a finished stretch: the unit of digest, archive and warm-up
  id TEXT PRIMARY KEY, machine TEXT NOT NULL, session TEXT NOT NULL, seq_from INTEGER NOT NULL, seq_to INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'hot', archived_at INTEGER, archive_node TEXT);
CREATE TABLE IF NOT EXISTS digests (         -- how a cold span is still found once its blocks have gone
  span TEXT PRIMARY KEY, keywords TEXT NOT NULL, facets TEXT NOT NULL, summary TEXT NOT NULL,
  made_at INTEGER NOT NULL, made_by TEXT NOT NULL, run TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS digests_fts USING fts5(keywords, summary, content='digests', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS digests_ai AFTER INSERT ON digests BEGIN
  INSERT INTO digests_fts(rowid, keywords, summary) VALUES (new.rowid, new.keywords, new.summary); END;
CREATE TRIGGER IF NOT EXISTS digests_ad AFTER DELETE ON digests BEGIN
  INSERT INTO digests_fts(digests_fts, rowid, keywords, summary) VALUES ('delete', old.rowid, old.keywords, old.summary); END;
CREATE TABLE IF NOT EXISTS transcript_files (
  path TEXT PRIMARY KEY,
  machine TEXT NOT NULL, session TEXT,
  offset INTEGER NOT NULL DEFAULT 0,  -- bytes captured: every complete line before it is in
  size INTEGER NOT NULL DEFAULT 0,    -- the file's size when last read
  tail_hash TEXT,                     -- sha256 of the last captured line, to tell a rewritten file from a grown one
  tail_len INTEGER NOT NULL DEFAULT 0,
  lines INTEGER NOT NULL DEFAULT 0, parts INTEGER NOT NULL DEFAULT 0, redactions INTEGER NOT NULL DEFAULT 0,
  state TEXT,                         -- the parser's carry-over (open tool calls, a pending boundary)
  skipped TEXT,                       -- why this file is not captured (a headless run), if it is not
  mtime INTEGER, updated_at INTEGER);
`

/** How many blocks before a memory's write make its anchor: the stretch that produced it. */
export const ANCHOR_BLOCKS = 8

/** A span is cold when its stretch ended this long ago and none of its blocks kept any heat. */
export const COLD = { days: 30, heat: 0.1, maxBlocks: 40, minBlocks: 4 } as const

export type Span = { id: string; machine: string; session: string; seq_from: number; seq_to: number; blocks: BlockRow[] }
export type Digest = { span: string; keywords: string[]; facets: string[]; summary: string; made_at: number; made_by: string }

export type FileCursor = {
  path: string
  machine: string
  session: string | null
  offset: number
  size: number
  tail_hash: string | null
  tail_len: number
  lines: number
  parts: number
  redactions: number
  state: string | null
  skipped: string | null
  mtime: number | null
  updated_at: number | null
}

/** A block as it travels between machines: identity (machine, session, key) and its origin's sequence, no local id. */
export type ReplicaBlock = { machine: string; session: string; seq: number; key: string; speaker: string; at: number; text: string; boundary: number; source: string; party: string | null; mseq: number }

const isReplicaBlock = (x: unknown): x is ReplicaBlock => {
  const b = x as Record<string, unknown>
  return (
    !!b && typeof b.machine === 'string' && !!b.machine && typeof b.session === 'string' && typeof b.key === 'string' && typeof b.speaker === 'string' &&
    typeof b.text === 'string' && typeof b.source === 'string' && Number.isInteger(b.seq) && Number.isInteger(b.mseq) && (b.mseq as number) > 0 &&
    typeof b.at === 'number' && (b.party === null || b.party === undefined || typeof b.party === 'string')
  )
}

export type BlockRow = { id: number; machine: string; session: string; seq: number; speaker: string; at: number; text: string; boundary: number; source: string; party: string | null }

/** Lines with a secret finding are replaced whole: the scanner reports lines and kinds, never values. */
export const redact = (text: string): { text: string; count: number } => {
  const findings = scanForSecrets(text)
  if (!findings.length) return { text, count: 0 }
  const byLine = new Map<number, string>()
  for (const f of findings) if (!byLine.has(f.line)) byLine.set(f.line, f.kind)
  return {
    text: text
      .split('\n')
      .map((l, i) => (byLine.has(i + 1) ? `[redacted: ${byLine.get(i + 1)}]` : l))
      .join('\n'),
    count: byLine.size,
  }
}

export class ContextStore {
  readonly db: Database.Database
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
    // Blocks travel between machines by a per-origin sequence that moves on every change (private mind, design 3.1).
    const cols = new Set((this.db.prepare('PRAGMA table_info(blocks)').all() as { name: string }[]).map((c) => c.name))
    if (!cols.has('mseq')) {
      this.db.exec('ALTER TABLE blocks ADD COLUMN mseq INTEGER')
      this.db.exec('UPDATE blocks SET mseq = id WHERE mseq IS NULL')
      this.db.exec('CREATE INDEX IF NOT EXISTS blocks_by_mseq ON blocks (machine, mseq)')
    }
  }

  cursor(p: string): FileCursor | undefined {
    return this.db.prepare('SELECT * FROM transcript_files WHERE path = ?').get(p) as FileCursor | undefined
  }

  cursors(): FileCursor[] {
    return this.db.prepare('SELECT * FROM transcript_files').all() as FileCursor[]
  }

  saveCursor(c: FileCursor): void {
    this.db
      .prepare(
        `INSERT INTO transcript_files (path, machine, session, offset, size, tail_hash, tail_len, lines, parts, redactions, state, skipped, mtime, updated_at)
         VALUES (@path, @machine, @session, @offset, @size, @tail_hash, @tail_len, @lines, @parts, @redactions, @state, @skipped, @mtime, @updated_at)
         ON CONFLICT(path) DO UPDATE SET machine=excluded.machine, session=excluded.session, offset=excluded.offset, size=excluded.size,
           tail_hash=excluded.tail_hash, tail_len=excluded.tail_len, lines=excluded.lines, parts=excluded.parts, redactions=excluded.redactions,
           state=excluded.state, skipped=excluded.skipped, mtime=excluded.mtime, updated_at=excluded.updated_at`,
      )
      .run(c)
  }

  session(machine: string, session: string, meta: SessionMeta & { parent?: string }, at?: number): void {
    this.db
      .prepare(
        `INSERT INTO sessions (machine, session, parent, agent, cwd, branch, version, title, entrypoint, first_at, last_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(machine, session) DO UPDATE SET
           parent = COALESCE(excluded.parent, parent), agent = COALESCE(excluded.agent, agent), cwd = COALESCE(excluded.cwd, cwd),
           branch = COALESCE(excluded.branch, branch), version = COALESCE(excluded.version, version), title = COALESCE(excluded.title, title),
           entrypoint = COALESCE(excluded.entrypoint, entrypoint),
           first_at = MIN(COALESCE(first_at, excluded.first_at), COALESCE(excluded.first_at, first_at)),
           last_at = MAX(COALESCE(last_at, excluded.last_at), COALESCE(excluded.last_at, last_at))`,
      )
      .run(machine, session, meta.parent ?? null, meta.agent ?? null, meta.cwd ?? null, meta.branch ?? null, meta.version ?? null, meta.title ?? null, meta.entrypoint ?? null, at ?? null, at ?? null)
  }

  /** What kind of session this was: a subagent (parent), a named agent, and how it was started. */
  sessionInfo(machine: string, session: string): { entrypoint: string | null; agent: string | null; parent: string | null; cwd: string | null } | undefined {
    return this.db.prepare('SELECT entrypoint, agent, parent, cwd FROM sessions WHERE machine = ? AND session = ?').get(machine, session) as never
  }

  /** Apply one part. Returns whether it was new, and how many lines it had redacted. */
  apply(machine: string, session: string, p: BlockPart, source = 'transcript'): { added: boolean; redacted: number } {
    const seen = this.db.prepare('INSERT OR IGNORE INTO block_parts (machine, session, uuid) VALUES (?,?,?)').run(machine, session, p.uuid).changes
    if (!seen) return { added: false, redacted: 0 }
    const { text, count } = redact(p.text)
    const existing = this.db.prepare('SELECT id, text FROM blocks WHERE machine = ? AND session = ? AND key = ?').get(machine, session, p.key) as
      | { id: number; text: string }
      | undefined
    const mseq = this.#nextMseq(machine)
    if (existing) {
      this.db.prepare('UPDATE blocks SET text = ?, mseq = ? WHERE id = ?').run(`${existing.text}\n\n${text}`, mseq, existing.id)
    } else {
      const { n } = this.db.prepare('SELECT COALESCE(MAX(seq), 0) n FROM blocks WHERE machine = ? AND session = ?').get(machine, session) as { n: number }
      this.db
        .prepare('INSERT INTO blocks (machine, session, seq, key, speaker, at, text, boundary, source, party, mseq) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(machine, session, n + 1, p.key, p.speaker, p.at, text, p.boundary ? 1 : 0, source, p.party ?? null, mseq)
    }
    return { added: true, redacted: count }
  }

  /**
   * Anchor a memory file's write to the dialogue that led to it: the `n` blocks
   * of that session up to the moment of the write. A write before any block
   * anchors nothing. Applying the same write twice is a no-op.
   */
  anchor(machine: string, session: string, source: string, at: number, how: 'capture' | 'backfill', n = ANCHOR_BLOCKS): boolean {
    const last = this.db.prepare('SELECT MAX(seq) s FROM blocks WHERE machine = ? AND session = ? AND at <= ?').get(machine, session, at) as { s: number | null }
    if (!last.s) return false
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO anchors (source, at, machine, session, seq_from, seq_to, how) VALUES (?,?,?,?,?,?,?)')
        .run(source, at, machine, session, Math.max(1, last.s - n + 1), last.s, how).changes > 0
    )
  }

  /** A memory's anchors, by the file it was written to, newest first. */
  anchorsFor(source: string): { source: string; at: number; machine: string; session: string; seq_from: number; seq_to: number; how: string }[] {
    return this.db.prepare('SELECT * FROM anchors WHERE source = ? ORDER BY at DESC').all(source) as never
  }

  /** The anchored stretch itself. */
  anchoredBlocks(a: { machine: string; session: string; seq_from: number; seq_to: number }): BlockRow[] {
    return this.db
      .prepare('SELECT * FROM blocks WHERE machine = ? AND session = ? AND seq BETWEEN ? AND ? ORDER BY seq')
      .all(a.machine, a.session, a.seq_from, a.seq_to) as BlockRow[]
  }

  /** Remove everything captured for one session: a transcript found to be a headless run leaves nothing behind. */
  dropSession(machine: string, session: string): void {
    this.db.prepare('DELETE FROM blocks WHERE machine = ? AND session = ?').run(machine, session)
    this.db.prepare('DELETE FROM block_parts WHERE machine = ? AND session = ?').run(machine, session)
    this.db.prepare('DELETE FROM sessions WHERE machine = ? AND session = ?').run(machine, session)
    this.db.prepare('DELETE FROM anchors WHERE machine = ? AND session = ?').run(machine, session)
  }

  /** Keyword search over blocks (BM25). The query is taken as words, never as FTS syntax. */
  search(query: string, limit = 10): (BlockRow & { score: number })[] {
    const terms = query
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length > 1)
      .map((t) => `"${t.replace(/"/g, '')}"`)
    if (!terms.length) return []
    return this.db
      .prepare(
        `SELECT b.*, bm25(blocks_fts) AS score FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid
         WHERE blocks_fts MATCH ? ORDER BY score LIMIT ?`,
      )
      .all(terms.join(' OR '), limit) as (BlockRow & { score: number })[]
  }

  /** Tool failures since a time, each with what the assistant said next: the raw material for tool lessons. */
  toolFailures(since: number, limit = 2_000): { note: string; reaction: string; session: string }[] {
    return this.db
      .prepare(
        `SELECT f.text note, f.session session,
           COALESCE((SELECT r.text FROM blocks r WHERE r.machine = f.machine AND r.session = f.session AND r.seq > f.seq AND r.speaker = 'assistant' ORDER BY r.seq LIMIT 1), '') reaction
         FROM blocks f WHERE f.speaker = 'tool-note' AND f.at >= ? ORDER BY f.at DESC LIMIT ?`,
      )
      .all(since, limit) as { note: string; reaction: string; session: string }[]
  }

  /**
   * Cold spans without a digest. A session's blocks are cut into spans at
   * compactions and every COLD.maxBlocks blocks, only once the session has been
   * quiet for COLD.days, so a span never changes after it is cut. Spans too
   * short to be worth a digest, and spans any block of which is still warm, are left.
   */
  coldSpans(limit: number, now = Date.now()): Span[] {
    const quiet = now - COLD.days * 86_400_000
    const sessions = this.db
      .prepare(
        `SELECT machine, session FROM blocks GROUP BY machine, session HAVING MAX(at) < ?
         ORDER BY MAX(at) DESC`,
      )
      .all(quiet) as { machine: string; session: string }[]
    const out: Span[] = []
    const blocksOf = this.db.prepare('SELECT * FROM blocks WHERE machine = ? AND session = ? ORDER BY seq')
    const hasDigest = this.db.prepare('SELECT 1 FROM digests WHERE span = ?')
    const heat = this.db.prepare("SELECT score, last_at FROM heat WHERE kind = 'block' AND target = ?")
    for (const s of sessions) {
      const blocks = blocksOf.all(s.machine, s.session) as BlockRow[]
      const cut: BlockRow[][] = []
      for (const b of blocks) {
        const cur = cut.at(-1)
        if (!cur || b.boundary || cur.length >= COLD.maxBlocks) cut.push([b])
        else cur.push(b)
      }
      for (const span of cut) {
        if (span.length < COLD.minBlocks) continue
        const id = `${s.machine}:${s.session}:${span[0]!.seq}`
        if (hasDigest.get(id)) continue
        const warm = span.some((b) => {
          const h = heat.get(String(b.id)) as { score: number; last_at: number } | undefined
          return !!h && heatNow(h.score, h.last_at, now) >= COLD.heat
        })
        if (warm) continue
        out.push({ id, machine: s.machine, session: s.session, seq_from: span[0]!.seq, seq_to: span.at(-1)!.seq, blocks: span })
        if (out.length >= limit) return out
      }
    }
    return out
  }

  putDigest(span: Omit<Span, 'blocks'>, d: Omit<Digest, 'span'>, run: string): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO spans (id, machine, session, seq_from, seq_to) VALUES (?,?,?,?,?)').run(span.id, span.machine, span.session, span.seq_from, span.seq_to)
      this.db
        .prepare('INSERT OR REPLACE INTO digests (span, keywords, facets, summary, made_at, made_by, run) VALUES (?,?,?,?,?,?,?)')
        .run(span.id, d.keywords.join(' '), d.facets.join(' '), d.summary, d.made_at, d.made_by, run)
    })()
  }

  digest(span: string): (Digest & { run: string | null }) | undefined {
    const r = this.db.prepare('SELECT * FROM digests WHERE span = ?').get(span) as Record<string, string | number | null> | undefined
    if (!r) return undefined
    return { span, keywords: String(r.keywords).split(' ').filter(Boolean), facets: String(r.facets).split(' ').filter(Boolean), summary: String(r.summary), made_at: Number(r.made_at), made_by: String(r.made_by), run: r.run as string | null }
  }

  /** Undo a consolidation run's digests. The spans stay: they are cut the same way again. */
  dropDigests(run: string): number {
    return this.db.prepare('DELETE FROM digests WHERE run = ?').run(run).changes
  }

  searchDigests(query: string, limit = 5): { span: string; summary: string; keywords: string; score: number }[] {
    const terms = query
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length > 1)
      .map((t) => `"${t.replace(/"/g, '')}"`)
    if (!terms.length) return []
    return this.db
      .prepare(
        `SELECT d.span span, d.summary summary, d.keywords keywords, bm25(digests_fts) score FROM digests_fts
         JOIN digests d ON d.rowid = digests_fts.rowid WHERE digests_fts MATCH ? ORDER BY score LIMIT ?`,
      )
      .all(terms.join(' OR '), limit) as { span: string; summary: string; keywords: string; score: number }[]
  }

  #nextMseq(machine: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(mseq), 0) n FROM blocks WHERE machine = ?').get(machine) as { n: number }).n + 1
  }

  // ── replication (private mind, design 3.1): generic, memory never syncs by itself ──

  /** The highest block sequence held from each machine. */
  blockVector(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.db.prepare('SELECT machine, MAX(mseq) n FROM blocks GROUP BY machine').all() as { machine: string; n: number }[]) out[r.machine] = r.n
    return out
  }

  /** Blocks beyond a vector, in sequence per machine, without local row ids. */
  streamBlocks(since: Record<string, number> = {}, limit = 10_000): ReplicaBlock[] {
    const out: ReplicaBlock[] = []
    for (const machine of Object.keys(this.blockVector())) {
      const rows = this.db
        .prepare('SELECT machine, session, seq, key, speaker, at, text, boundary, source, party, mseq FROM blocks WHERE machine = ? AND mseq > ? ORDER BY mseq LIMIT ?')
        .all(machine, since[machine] ?? 0, limit - out.length) as ReplicaBlock[]
      out.push(...rows)
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * Keep blocks from other machines. A block is (machine, session, key): a newer
   * version of one already held replaces it. Text is secret-scanned again here:
   * the origin's scanner may be older than this one.
   */
  adoptBlocks(blocks: unknown[], self: string): { added: number; updated: number; rejected: number } {
    let added = 0
    let updated = 0
    let rejected = 0
    const get = this.db.prepare('SELECT id, mseq FROM blocks WHERE machine = ? AND session = ? AND key = ?')
    const insert = this.db.prepare('INSERT INTO blocks (machine, session, seq, key, speaker, at, text, boundary, source, party, mseq) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    const update = this.db.prepare('UPDATE blocks SET text = ?, mseq = ? WHERE id = ?')
    this.db.transaction(() => {
      for (const x of blocks) {
        if (!isReplicaBlock(x)) {
          rejected++
          continue
        }
        if (x.machine === self) continue
        const text = redact(x.text).text
        const have = get.get(x.machine, x.session, x.key) as { id: number; mseq: number | null } | undefined
        if (!have) {
          insert.run(x.machine, x.session, x.seq, x.key, x.speaker, x.at, text, x.boundary ? 1 : 0, x.source, x.party ?? null, x.mseq)
          added++
        } else if ((have.mseq ?? 0) < x.mseq) {
          update.run(text, x.mseq, have.id)
          updated++
        }
      }
    })()
    return { added, updated, rejected }
  }

  /** The blocks around one, within its session: context(n). */
  window(id: number, n: number): BlockRow[] {
    const b = this.db.prepare('SELECT machine, session, seq FROM blocks WHERE id = ?').get(id) as { machine: string; session: string; seq: number } | undefined
    if (!b) return []
    return this.db
      .prepare('SELECT * FROM blocks WHERE machine = ? AND session = ? AND seq BETWEEN ? AND ? ORDER BY seq')
      .all(b.machine, b.session, b.seq - n, b.seq + n) as BlockRow[]
  }

  /**
   * context(n) across channels: the window in the block's own session, plus the
   * same member's blocks on its other channels in that window's time span (a
   * transcript and its Telegram or bus conversation, interleaved by time).
   */
  windowAcross(id: number, n: number): BlockRow[] {
    const own = this.window(id, n)
    if (!own.length) return own
    const first = own[0]!
    const title = (this.db.prepare('SELECT title FROM sessions WHERE machine = ? AND session = ?').get(first.machine, first.session) as { title: string | null } | undefined)?.title
    if (!title) return own
    const from = Math.min(...own.map((b) => b.at))
    const to = Math.max(...own.map((b) => b.at))
    // The span, plus up to n on each side: a hit on a channel spans a moment, and still needs its surroundings.
    // A member's channels carry its name; a message to its role carries `role:<role>` (members are named `<role>-<n>`).
    const asRole = title.startsWith('role:') ? title : `role:${title.replace(/-\d+$/, '')}`
    const other = `FROM blocks b JOIN sessions s ON s.machine = b.machine AND s.session = b.session
         WHERE s.title IN (?, ?) AND NOT (b.machine = ? AND b.session = ?)`
    const args = [title, asRole, first.machine, first.session]
    const linked = [
      ...(this.db.prepare(`SELECT b.* ${other} AND b.at BETWEEN ? AND ?`).all(...args, from, to) as BlockRow[]),
      ...(this.db.prepare(`SELECT b.* ${other} AND b.at < ? ORDER BY b.at DESC LIMIT ?`).all(...args, from, n) as BlockRow[]),
      ...(this.db.prepare(`SELECT b.* ${other} AND b.at > ? ORDER BY b.at ASC LIMIT ?`).all(...args, to, n) as BlockRow[]),
    ]
    const seen = new Set<number>()
    return [...own, ...linked].filter((b) => !seen.has(b.id) && seen.add(b.id)).sort((a, b) => a.at - b.at || a.id - b.id)
  }

  /** Grade targets: `related` when surfaced, `used` when the answer cited them. Heat decays before it grows. */
  touchHeat(targets: string[], kind: 'block' | 'memory', grade: 'related' | 'used', now = Date.now()): void {
    const add = grade === 'used' ? HEAT.used : HEAT.related
    const get = this.db.prepare('SELECT score, last_at FROM heat WHERE target = ? AND kind = ?')
    const put = this.db.prepare(
      `INSERT INTO heat (target, kind, score, used, related, last_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(target, kind) DO UPDATE SET score = excluded.score, used = used + excluded.used, related = related + excluded.related, last_at = excluded.last_at`,
    )
    this.db.transaction(() => {
      for (const t of targets) {
        const prev = get.get(t, kind) as { score: number; last_at: number } | undefined
        const score = (prev ? heatNow(prev.score, prev.last_at, now) : 0) + add
        put.run(t, kind, score, grade === 'used' ? 1 : 0, grade === 'related' ? 1 : 0, now)
      }
    })()
  }

  heat(target: string, kind: 'block' | 'memory', now = Date.now()): number {
    const r = this.db.prepare('SELECT score, last_at FROM heat WHERE target = ? AND kind = ?').get(target, kind) as { score: number; last_at: number } | undefined
    return r ? heatNow(r.score, r.last_at, now) : 0
  }

  logPull(at: number, session: string | undefined, query: string, blocks: number[]): number {
    return Number(this.db.prepare('INSERT INTO pulls (at, session, query, blocks) VALUES (?,?,?,?)').run(at, session ?? null, query, JSON.stringify(blocks)).lastInsertRowid)
  }

  markPullUsed(session: string, at: number): void {
    this.db.prepare("UPDATE pulls SET quality = 'used' WHERE session = ? AND at = ?").run(session, at)
  }

  /**
   * What the user said since a time, oldest first, each with the speaker of the
   * block before it in its session: a correction answers something the
   * assistant just did.
   */
  userSince(since: number, limit = 5_000): { text: string; at: number; session: string; after: string | null }[] {
    return this.db
      .prepare(
        `SELECT b.text, b.at, b.session,
           (SELECT p.speaker FROM blocks p WHERE p.machine = b.machine AND p.session = b.session AND p.seq < b.seq ORDER BY p.seq DESC LIMIT 1) AS after
         FROM blocks b WHERE b.speaker IN ('user', 'operator') AND b.at >= ? ORDER BY b.at LIMIT ?`,
      )
      .all(since, limit) as { text: string; at: number; session: string; after: string | null }[]
  }

  counts(): { sessions: number; blocks: number; files: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n
    return { sessions: one('SELECT COUNT(*) n FROM sessions'), blocks: one('SELECT COUNT(*) n FROM blocks'), files: one('SELECT COUNT(*) n FROM transcript_files') }
  }

  close(): void {
    this.db.close()
  }
}
