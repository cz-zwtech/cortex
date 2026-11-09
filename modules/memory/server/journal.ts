/**
 * The journal — the durable substrate after the first-class-memory inversion.
 *
 * V1's durable truth was the `.md` file on disk and the graph was derived
 * ("rebuild the graph from disk" was the disaster-recovery story). The
 * scratchpad charter empties those files, which INVERTS that: without a new
 * substrate the graph becomes the only copy, and `graph.sqlite` with no
 * reconstructable source is a single point of total memory loss.
 *
 *   journal = source of truth  ·  graph = derived view  ·  memory `.md` = INPUT
 *   surface (write-inbox)      ·  MEMORY.md = OUTPUT surface (rendered digest)
 *
 * Files stop being storage and become I/O.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIVE DECISIONS THAT CARRY THE WEIGHT
 *
 * 1. THE JOURNAL DOES NOT LIVE IN graph.sqlite.
 *    "Rebuild the graph from the journal" is circular if the journal is a table
 *    in the graph. Segment files on disk, independent of the database, so the
 *    recovery story survives losing it entirely.
 *
 * 2. APPEND HAPPENS AFTER THE SECRET GATE AND BEFORE EVERYTHING ELSE.
 *    The scan is the ONLY step permitted between arrival and append, because the
 *    journal is precisely the thing you cannot take content back out of. Once a
 *    credential is appended and replicated, everything downstream is damage
 *    limitation rather than prevention. Past the append, nothing can lose text.
 *
 * 3. QUARANTINED CONTENT IS NOT IN THE JOURNAL AT ALL.
 *    Not "appended and flagged" — held OUT. A quarantine record that reached the
 *    journal would defeat its own purpose, since the journal replicates. The
 *    quarantine is local, deletable, and lives elsewhere.
 *
 * 4. SEGMENTS, BECAUSE REDACTION NEEDS SOMETHING SMALLER THAN "THE JOURNAL" TO
 *    REWRITE. Append-only with no rewrite path makes redaction impossible by
 *    construction. Rewriting one bounded segment is cheap; rewriting a single
 *    unbounded log is not.
 *
 * 5. THE REDACTION MANIFEST IS A SEPARATE FILE FROM THE SEGMENTS.
 *    An earlier revision appended redaction records into the segments — which
 *    put a record that must be PERMANENT inside the very files a redaction
 *    rewrites, and inside the files a restore replaces. Restore a segment set
 *    from a pre-redaction backup and the redaction records vanish with it, so
 *    nothing is left to replay and the credential comes back. The manifest is
 *    its own append-only file, never rewritten and never compacted.
 *
 * 6. REDACTION RECORDS ARE PERMANENT AND CARRY NO PAYLOAD.
 *    They survive the compaction that executes them — otherwise a backup taken
 *    before a redaction and restored after it silently un-redacts, which is a
 *    live risk precisely because interval graph backups are a named durability
 *    leg. And the tombstone must not contain the body, or the manifest becomes
 *    the leak it exists to prevent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON THE HASH: it is a PLAIN hash over the content as stored. No canonicalizing
 * regex is frozen into the format — the journal holds the content, so any hash
 * over it is derived and recomputable, and freezing a normalization would buy
 * nothing and cost a migration. The graph-side consume ledger normalizes for its
 * own purposes and is rebuilt by replay, so it may change freely.
 *
 * ON JOURNAL vs OUTBOX: same append moment, two retention policies. The journal
 * is durability and is kept; the outbox is transport and drains. Stated here
 * because conflating them is how a system ends up with three overlapping logs.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Bytes per segment before rolling. Bounded so a redaction rewrite is cheap. */
export const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024

export type MemoryRecord = {
  kind: 'memory'
  /** Journal-assigned, monotonic within this machine. */
  seq: number
  /** Declared slug, when the writer supplied one. Identity is decided by the graph. */
  slug?: string
  /** Where it arrived from. PROVENANCE — never identity. */
  source: string
  scope: string
  machine: string
  authoredAt: number
  appendedAt: number
  /** Plain hash over `content` as stored. */
  contentHash: string
  /** Full text, frontmatter included. This is the durable copy. */
  content: string
  /** The session that wrote it, when known: provenance, and what a memory's anchors hang on. */
  session?: string
  /** Knowledge travels when minds sync; working detail stays home (classify.ts). Absent on records from before. */
  syncClass?: 'knowledge' | 'working'
}

/**
 * A deletion, expressed the only way an append-only log can express one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDRESSED BY CONTENT HASH, NOT BY GRAPH ID — AND IT HAD TO BE
 *
 * The first version carried only `memoryId`, and `replay()` dutifully collected
 * those ids into a set it then never used. That looked like a forgotten filter.
 * It was not: `MemoryRecord` HAS NO GRAPH ID. Identity is decided by the graph,
 * deliberately, so the journal has no field to join a tombstone against. The set
 * was not merely unused, it was unusable — and the method's doc comment claimed
 * "tombstones already applied" the whole time.
 *
 * So a tombstone targets a content hash, exactly as a redaction does, and for
 * the same reason: a hash is stable across generations and identifies the record
 * in a log that never knew the graph's ids.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND IT IS BOUNDED BY SEQUENCE, WHICH A REDACTION IS NOT
 *
 * A redaction suppresses a hash FOREVER — that is the point, the secret must
 * never come back. A deletion must not: if the user deletes a memory and later
 * writes the same fact again, the new one is a legitimate memory and must live.
 *
 * So a tombstone suppresses matching records appended BEFORE it, and nothing
 * after. Same mechanism, one extra condition, and the difference between them is
 * the difference between "forget this" and "this must never exist again".
 */
export type TombstoneRecord = {
  kind: 'tombstone'
  seq: number
  /** The graph id, kept for provenance and reporting. NEVER used to match. */
  memoryId: string
  /** What is being deleted. The only field replay can actually join on. */
  targetHash: string
  machine: string
  appendedAt: number
}

/**
 * A redaction. PERMANENT — survives the compaction that executes it, and is
 * never itself compacted away.
 *
 * Addressed by CONTENT HASH, never by byte offset. The manifest must be
 * re-appliable against a PRE-redaction backup whose segment geometry differs
 * from the current generation; a hash is stable across every generation, an
 * offset is an invitation for a replay that misses.
 *
 * Carries NO payload. Deliberately.
 */
export type RedactionRecord = {
  kind: 'redaction'
  seq: number
  /** Monotonic. The graph stores the epoch it has applied; boot reconciles. */
  epoch: number
  /** Hash of the record being redacted. The address, and nothing more. */
  targetHash: string
  targetMemoryId?: string
  machine: string
  appendedAt: number
  /** Free text for the human. MUST NOT quote the redacted content. */
  note?: string
}

/**
 * A graph change made by a consolidation run (design 4.8): auditable, and
 * replicated later with the rest of the journal. It never carries memory
 * text; replay of memories ignores it.
 */
export type ConsolidationRecord = {
  kind: 'consolidation'
  seq: number
  run: string
  op: string
  args: Record<string, unknown>
  machine: string
  appendedAt: number
}

export type JournalRecord = MemoryRecord | TombstoneRecord | RedactionRecord | ConsolidationRecord

export const hashContent = (content: string): string =>
  createHash('sha256').update(content, 'utf-8').digest('hex')

const SEGMENT_RE = /^segment-(\d{6})\.ndjson$/
const MANIFEST = 'redactions.ndjson'

/**
 * Records adopted from other machines, kept verbatim with their origin's seq,
 * one file per origin under `peers/`. Own segments stay this machine's alone,
 * so its seq numbering never mixes with anyone else's. A `gap` line marks a
 * record that was seen but is not kept (it was redacted here), so the version
 * vector still moves past it.
 */
const PEERS = 'peers'
export type GapLine = { kind: 'gap'; machine: string; seq: number }
export const isGap = (r: unknown): r is GapLine => {
  const x = r as Record<string, unknown>
  return !!x && x.kind === 'gap' && typeof x.machine === 'string' && !!x.machine && Number.isInteger(x.seq) && (x.seq as number) > 0
}
export type VersionVector = Record<string, number>

const KINDS = new Set(['memory', 'tombstone', 'redaction', 'consolidation'])
/** A record from elsewhere, checked field by field before it is kept. */
export const isJournalRecord = (r: unknown): r is JournalRecord => {
  const x = r as Record<string, unknown>
  if (!x || !KINDS.has(x.kind as string) || typeof x.machine !== 'string' || !x.machine || !Number.isInteger(x.seq) || (x.seq as number) < 1) return false
  if (typeof x.appendedAt !== 'number') return false
  if (x.kind === 'memory') return typeof x.content === 'string' && typeof x.contentHash === 'string' && typeof x.scope === 'string' && typeof x.source === 'string'
  if (x.kind === 'tombstone' || x.kind === 'redaction') return typeof x.targetHash === 'string'
  return typeof x.op === 'string'
}

export type JournalOptions = {
  dir: string
  /**
   * This machine's id, stamped on records THIS journal originates.
   *
   * Required, not defaulted. A redaction is a permanent, replicated record, and
   * one that cannot say which machine issued it is unattributable forever — the
   * kind of empty field that gets filled in with a placeholder and shipped.
   * Adopted memory records keep their OWN machine lineage and do not use this.
   */
  machine: string
  segmentBytes?: number
  /**
   * Escape hatch for the drvfs refusal. Present so a test can exercise the
   * path, and so an operator who knows better is not blocked — NOT because the
   * refusal is advisory.
   */
  allowUnsafeFilesystem?: boolean
}

export type IntegrityEvent = { segment: string; line: number; reason: string }

/**
 * Windows drive mounts under WSL. The durability story here rests on fsync and
 * rename semantics that drvfs does not provide, so a journal placed there would
 * report success it cannot deliver. Detected by path rather than by filesystem
 * probe: the probe is the more correct test and the path check is the one that
 * cannot itself fail on the filesystem it is testing.
 */
const looksLikeDrvfs = (dir: string): boolean => /^\/mnt\/[a-z]\//i.test(path.resolve(dir))

export class Journal {
  readonly #dir: string
  readonly #machine: string
  readonly #segmentBytes: number
  #seq = 0
  #epoch = 0
  #integrity: IntegrityEvent[] = []
  /** (origin machine -> seqs held), loaded on first use. */
  #peerSeen?: Map<string, Set<number>>

  constructor(opts: JournalOptions) {
    this.#dir = opts.dir
    this.#machine = opts.machine
    this.#segmentBytes = opts.segmentBytes ?? DEFAULT_SEGMENT_BYTES

    if (looksLikeDrvfs(this.#dir) && !opts.allowUnsafeFilesystem) {
      // The message names the FIX, not just the refusal. The realistic way to
      // arrive here is deriving the journal path from the install home — which
      // on a WSL primary is a checkout under /mnt/e — instead of from the state
      // dir, which is already on ext4. A refusal that only says "no" sends the
      // reader looking for a filesystem problem instead of a path-resolution one.
      throw new Error(
        `Refusing to open a journal on a Windows drive mount: ${this.#dir}\n` +
          'drvfs does not provide the fsync and rename semantics this journal\'s durability rests on, ' +
          'so it would report success it cannot deliver.\n' +
          'The usual cause is deriving the journal path from the INSTALL home (CKN_HOME, a checkout) ' +
          'rather than from the STATE dir (CKN_STATE_DIR, default ~/.config/ckn, already on the Linux ' +
          'filesystem). Fix the path resolution rather than the filesystem.\n' +
          'allowUnsafeFilesystem overrides this, and forfeits the durability guarantee.',
      )
    }

    fs.mkdirSync(this.#dir, { recursive: true })

    // Recover position from disk rather than from a sidecar counter. A counter
    // is a second source of truth for something the log already knows, and it
    // is exactly what goes stale after a crash or a segment rewrite.
    for (const r of this.read()) if (r.seq > this.#seq) this.#seq = r.seq
    for (const r of this.redactions()) {
      if (r.seq > this.#seq) this.#seq = r.seq
      if (r.epoch > this.#epoch) this.#epoch = r.epoch
    }
  }

  /** Segment files in order. */
  segments(): string[] {
    return fs
      .readdirSync(this.#dir)
      .filter((f) => SEGMENT_RE.test(f))
      .sort()
      .map((f) => path.join(this.#dir, f))
  }

  #activeSegment(): string {
    const existing = this.segments()
    const last = existing.at(-1)
    if (!last) return this.#segmentPath(0)

    // Roll on size. Checked before the write rather than after, so a segment
    // never exceeds the bound — a segment that grew past it would make the
    // redaction rewrite it exists to bound arbitrarily expensive.
    const size = fs.statSync(last).size
    if (size < this.#segmentBytes) return last

    const n = Number(SEGMENT_RE.exec(path.basename(last))![1]) + 1
    return this.#segmentPath(n)
  }

  #segmentPath(n: number): string {
    return path.join(this.#dir, `segment-${String(n).padStart(6, '0')}.ndjson`)
  }

  /**
   * Append a record. Durable before it returns.
   *
   * CONTRACT: NO OPERATION REPORTS SUCCESS UNTIL ITS RECORD IS FSYNCED. This is
   * the invariant that makes torn-tail-skip safe rather than merely convenient.
   * If an append acknowledged before its fsync completed, a power loss could
   * tear the very record the caller was told is durable — and replay would then
   * skip it silently. For a redaction record that is a silent un-redact of an
   * acknowledged redact.
   *
   * `fsync` on the file AND on the directory: without the directory sync a
   * freshly-rolled segment can survive as a filename with no data after a power
   * loss, which is the failure that makes a durability claim untrue exactly
   * when it is being relied on.
   */
  #append<T extends JournalRecord>(record: T): T {
    return this.#appendTo(this.#activeSegment(), record)
  }

  /**
   * SEQ IS ASSIGNED UNDER A LOCK, FROM DISK. Several Journal instances write one
   * directory: the module's own, each hook process's, the CLI's. Each counting
   * from its own memory gave two records the same seq (a sweep's memory and the
   * delete's tombstone, 28 Oct). Within one machine that only blurred a
   * tombstone's "before"; across machines (machine, seq) is a record's identity,
   * and a duplicate would be dropped as already held. So every append takes the
   * lock file, reads the high-water mark from the files' tails, and numbers from it.
   */
  #appendTo<T extends JournalRecord>(file: string, record: T): T {
    return this.#locked(() => {
      // The last two segments: a segment that just rolled over is still empty.
      this.#seq = this.#highWater()
      record.seq = ++this.#seq
      if (record.kind === 'redaction') {
        this.#epoch = Math.max(this.#epoch, ...this.redactions().map((r) => r.epoch))
        record.epoch = ++this.#epoch
      }
      return this.#write(file, record)
    })
  }

  /** The seq of a file's last record: what this machine has used up to, whoever appended it. */
  /** This machine's last seq, as the files hold it: other processes (hooks, CLIs) append too. */
  #highWater(): number {
    return Math.max(this.#seq, ...this.segments().slice(-2).map((f) => this.#tailSeq(f)), this.#tailSeq(path.join(this.#dir, MANIFEST)))
  }

  #tailSeq(file: string): number {
    if (!fs.existsSync(file)) return 0
    const size = fs.statSync(file).size
    if (!size) return 0
    const n = Math.min(size, 256 * 1024)
    const buf = Buffer.alloc(n)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buf, 0, n, size - n)
    } finally {
      fs.closeSync(fd)
    }
    const lines = buf.toString('utf-8').split('\n').filter((l) => l.trim())
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i]!) as { seq?: number }
        if (Number.isInteger(r.seq)) return r.seq!
      } catch {
        /* a torn tail or a cut first line: look further back */
      }
    }
    return 0
  }

  #locked<T>(fn: () => T): T {
    const lock = path.join(this.#dir, 'journal.lock')
    const deadline = Date.now() + 10_000
    for (;;) {
      try {
        fs.closeSync(fs.openSync(lock, 'wx'))
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        try {
          // A holder that died leaves its lock behind: one older than any append takes is stale.
          if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { force: true })
        } catch {
          /* gone already */
        }
        if (Date.now() > deadline) throw new Error(`journal busy: ${lock} held for over 10 s`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
    }
    try {
      return fn()
    } finally {
      fs.rmSync(lock, { force: true })
    }
  }

  #write<T extends JournalRecord>(file: string, record: T): T {
    const line = JSON.stringify(record) + '\n'

    const fd = fs.openSync(file, 'a')
    try {
      fs.writeSync(fd, line)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    const dir = fs.openSync(this.#dir, 'r')
    try {
      fs.fsyncSync(dir)
    } finally {
      fs.closeSync(dir)
    }

    return record
  }

  appendMemory(
    input: Omit<MemoryRecord, 'kind' | 'seq' | 'appendedAt' | 'contentHash'> & {
      appendedAt?: number
    },
  ): MemoryRecord {
    return this.#append<MemoryRecord>({
      ...input,
      kind: 'memory',
      seq: 0,
      appendedAt: input.appendedAt ?? Date.now(),
      contentHash: hashContent(input.content),
    })
  }

  appendConsolidation(input: Omit<ConsolidationRecord, 'kind' | 'seq' | 'appendedAt'>): ConsolidationRecord {
    return this.#append<ConsolidationRecord>({ ...input, kind: 'consolidation', seq: 0, appendedAt: Date.now() })
  }

  appendTombstone(
    input: Omit<TombstoneRecord, 'kind' | 'seq' | 'appendedAt'> & { appendedAt?: number },
  ): TombstoneRecord {
    return this.#append<TombstoneRecord>({
      ...input,
      kind: 'tombstone',
      seq: 0,
      appendedAt: input.appendedAt ?? Date.now(),
    })
  }

  /**
   * Append to the PERMANENT manifest — its own file, never rewritten, never
   * compacted. It must outlive both the rewrite it describes and any restore
   * of the segments, or a pre-redaction backup silently un-redacts.
   */
  appendRedaction(
    input: Omit<RedactionRecord, 'kind' | 'seq' | 'epoch' | 'appendedAt' | 'machine'> & {
      appendedAt?: number
    },
  ): RedactionRecord {
    const record: RedactionRecord = {
      ...input,
      machine: this.#machine,
      kind: 'redaction',
      seq: 0,
      epoch: 0,
      appendedAt: input.appendedAt ?? Date.now(),
    }
    this.#appendTo(path.join(this.#dir, MANIFEST), record)
    return record
  }

  /** Every redaction ever recorded, in order. Never pruned. */
  redactions(): RedactionRecord[] {
    const file = path.join(this.#dir, MANIFEST)
    if (!fs.existsSync(file)) return []
    const out: RedactionRecord[] = []
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as RedactionRecord)
      } catch {
        continue
      }
    }
    return out
  }

  /**
   * Every record, in order, across every segment.
   *
   * A TORN TAIL is skipped silently: a partial last line is the ordinary outcome
   * of a power loss mid-append, and the journal being readable is the whole
   * recovery story, so it must not throw.
   *
   * MID-SEGMENT DAMAGE IS A DIFFERENT EVENT ENTIRELY and must not share that
   * disposition. A malformed or hash-mismatched line with records after it is
   * disk corruption, not a tear — skipping it silently drops memories with
   * nothing reporting the loss. Same code path, different disposition, and the
   * difference is whether a failing disk announces itself or quietly eats
   * memories. Replay continues past it (salvage what is there) and the event is
   * recorded for `status`.
   */
  *read(): Generator<JournalRecord> {
    this.#integrity = []

    for (const seg of this.segments()) {
      const lines = fs.readFileSync(seg, 'utf-8').split('\n')
      // Index of the last line carrying anything: only THAT one can be a tear.
      let lastContent = -1
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]!.trim()) {
          lastContent = i
          break
        }
      }

      for (let i = 0; i <= lastContent; i++) {
        const line = lines[i]!
        if (!line.trim()) continue

        let rec: JournalRecord
        try {
          rec = JSON.parse(line) as JournalRecord
        } catch {
          if (i !== lastContent) {
            this.#integrity.push({
              segment: seg,
              line: i + 1,
              reason: 'unparseable mid-segment line — disk corruption, not a torn append',
            })
          }
          continue
        }

        // The hash is per-record and already stored, so verifying it costs one
        // hash and turns silent bit-rot into a reported event.
        if (rec.kind === 'memory' && hashContent(rec.content) !== rec.contentHash) {
          this.#integrity.push({
            segment: seg,
            line: i + 1,
            reason: `content hash mismatch on seq ${rec.seq} — record altered on disk`,
          })
        }

        yield rec
      }
    }
  }

  /**
   * Integrity events from the most recent read/replay.
   *
   * Surfaced in `status` rather than thrown: a corrupt journal must still give
   * back everything it can, and a human must still be told it happened.
   */
  integrity(): IntegrityEvent[] {
    return [...this.#integrity]
  }

  /** The highest redaction epoch this journal has recorded. */
  epoch(): number {
    return this.#epoch
  }

  /**
   * Replay for graph rebuild: every memory record, with redactions and
   * tombstones already applied.
   *
   * Redactions are applied HERE rather than left to the caller. A replay that
   * hands back redacted content and trusts every consumer to filter it is one
   * forgetful consumer away from resurrecting the secret.
   */
  replay(): MemoryRecord[] {
    const redactedHashes = this.#redactedHashes()

    // A tombstone suppresses records appended before it and nothing after, so a
    // later re-save of the same fact survives — which is what separates a
    // deletion from a redaction. On its own machine "before" is by seq; across
    // machines seqs do not compare, so it is by the time each was appended.
    const tombstones = new Map<string, TombstoneRecord[]>()
    const records: MemoryRecord[] = []

    for (const r of [...this.read(), ...this.peerRecords()]) {
      if (r.kind === 'tombstone') tombstones.set(r.targetHash, [...(tombstones.get(r.targetHash) ?? []), r])
      else if (r.kind === 'memory') records.push(r)
    }
    const killed = (r: MemoryRecord) =>
      (tombstones.get(r.contentHash) ?? []).some((t) => (t.machine === r.machine ? r.seq < t.seq : r.appendedAt <= t.appendedAt))

    return records.filter((r) => !redactedHashes.has(r.contentHash) && !killed(r))
  }

  // ── records from other machines (private mind, design 3.1) ─────────────────

  #peerFile(machine: string): string {
    return path.join(this.#dir, PEERS, `${machine.replace(/[^A-Za-z0-9._-]/g, '_')}.ndjson`)
  }

  #peerFiles(): string[] {
    const dir = path.join(this.#dir, PEERS)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort().map((f) => path.join(dir, f))
  }

  *#peerLines(): Generator<JournalRecord | GapLine> {
    for (const file of this.#peerFiles()) {
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        try {
          yield JSON.parse(line) as JournalRecord | GapLine
        } catch {
          continue // a torn tail: the record is fetched again, since the vector never moved past it
        }
      }
    }
  }

  /** Every record adopted from another machine, with its origin machine and seq. */
  *peerRecords(): Generator<JournalRecord> {
    for (const r of this.#peerLines()) if (r.kind !== 'gap') yield r
  }

  #seen(): Map<string, Set<number>> {
    if (!this.#peerSeen) {
      this.#peerSeen = new Map()
      for (const r of this.#peerLines()) {
        if (!this.#peerSeen.has(r.machine)) this.#peerSeen.set(r.machine, new Set())
        this.#peerSeen.get(r.machine)!.add(r.seq)
      }
    }
    return this.#peerSeen
  }

  /**
   * How far each machine's records are held WITHOUT A HOLE: the highest n with
   * every seq 1..n held (a gap marker counts). Not the highest seq held: a
   * sender may hold one record back (its writer not yet known) and send later
   * ones, and a receiver that jumped past it would never be sent it again.
   */
  versionVector(): VersionVector {
    // Read from the files, not this instance's counter: a long-running host would otherwise report
    // only its own appends, and a node would look behind its own records (the id guard refused on it).
    this.#seq = this.#highWater()
    const vv: VersionVector = { [this.#machine]: this.#seq }
    for (const [m, seqs] of this.#seen()) {
      let n = 0
      while (seqs.has(n + 1)) n++
      vv[m] = n
    }
    return vv
  }

  /**
   * Every record held beyond a version vector: this machine's (redactions
   * included) and those adopted from others, with the gap markers among them
   * (a node passing records on must pass their holes on too).
   */
  *stream(since: VersionVector = {}): Generator<JournalRecord | GapLine> {
    const own = since[this.#machine] ?? 0
    for (const r of this.read()) if (r.seq > own) yield r
    for (const r of this.redactions()) if (r.seq > own) yield r
    for (const r of this.#peerLines()) if (r.seq > (since[r.machine] ?? 0)) yield r
  }

  #redactedHashes(): Set<string> {
    const hashes = new Set(this.redactions().map((r) => r.targetHash))
    for (const r of this.peerRecords()) if (r.kind === 'redaction') hashes.add(r.targetHash)
    return hashes
  }

  /**
   * Keep records from other machines, verbatim. Idempotent on (machine, seq);
   * this machine's own records coming back are ignored. A memory whose content
   * no longer matches its hash is refused. A redaction from anywhere is applied
   * here too: its target leaves every segment and every peer file, and a record
   * of it arriving later is kept only as a gap.
   */
  adoptRecords(records: unknown[]): { added: JournalRecord[]; rejected: number } {
    const seen = this.#seen()
    const redacted = this.#redactedHashes()
    const added: JournalRecord[] = []
    const lines = new Map<string, string[]>()
    let rejected = 0
    for (const r of records) {
      // A gap marker: the origin will never send this seq (sent as a pointer, or kept home). Held as a gap.
      if (isGap(r)) {
        if (r.machine === this.#machine || seen.get(r.machine)?.has(r.seq)) continue
        if (!seen.has(r.machine)) seen.set(r.machine, new Set())
        seen.get(r.machine)!.add(r.seq)
        const file = this.#peerFile(r.machine)
        lines.set(file, [...(lines.get(file) ?? []), JSON.stringify({ kind: 'gap', machine: r.machine, seq: r.seq })])
        continue
      }
      if (!isJournalRecord(r) || (r.kind === 'memory' && hashContent(r.content) !== r.contentHash)) {
        rejected++
        continue
      }
      if (r.machine === this.#machine || seen.get(r.machine)?.has(r.seq)) continue
      if (!seen.has(r.machine)) seen.set(r.machine, new Set())
      seen.get(r.machine)!.add(r.seq)
      if (r.kind === 'redaction') redacted.add(r.targetHash)
      const keep = !(r.kind === 'memory' && redacted.has(r.contentHash))
      const line: JournalRecord | GapLine = keep ? r : { kind: 'gap', machine: r.machine, seq: r.seq }
      const file = this.#peerFile(r.machine)
      lines.set(file, [...(lines.get(file) ?? []), JSON.stringify(line)])
      if (keep) added.push(r)
    }
    if (lines.size) fs.mkdirSync(path.join(this.#dir, PEERS), { recursive: true })
    for (const [file, ls] of lines) {
      const fd = fs.openSync(file, 'a')
      try {
        fs.writeSync(fd, ls.join('\n') + '\n')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    }
    for (const r of added) if (r.kind === 'redaction') this.#applyRedaction(r.targetHash)
    return { added, rejected }
  }

  /** Take a redacted record out of the peer files, leaving a gap so the vector still covers it. */
  #scrubPeers(targetHash: string): number {
    let removed = 0
    for (const file of this.#peerFiles()) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim())
      let changed = false
      const kept = lines.map((line) => {
        try {
          const r = JSON.parse(line) as JournalRecord | GapLine
          if (r.kind === 'memory' && r.contentHash === targetHash) {
            removed++
            changed = true
            return JSON.stringify({ kind: 'gap', machine: r.machine, seq: r.seq })
          }
        } catch {
          /* a torn line is kept as it is */
        }
        return line
      })
      if (!changed) continue
      const tmp = `${file}.tmp-redact`
      fs.writeFileSync(tmp, kept.join('\n') + '\n')
      const fd = fs.openSync(tmp, 'r')
      try {
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, file)
    }
    return removed
  }

  /**
   * Execute a redaction: rewrite every segment without the target record.
   *
   * The redaction RECORD is appended first and is never removed by this pass —
   * it must outlive the rewrite it describes, or a peer restored from a
   * pre-redaction backup replays nothing and the content comes back.
   *
   * Returns the number of content records removed. Zero is a legitimate answer
   * (already redacted, or never here) and is NOT an error — a redaction must be
   * safely re-runnable, since the alternative is a half-applied one.
   */
  redact(targetHash: string, opts: { memoryId?: string; note?: string } = {}): number {
    this.appendRedaction({ targetHash, targetMemoryId: opts.memoryId, note: opts.note })
    return this.#applyRedaction(targetHash)
  }

  /**
   * Re-apply every recorded redaction to the segments.
   *
   * The half of boot reconciliation that repairs the JOURNAL. Restoring segments
   * from a pre-redaction backup brings the content back; the manifest is a
   * separate file and survives, so replaying it removes the content again with
   * no human step.
   */
  replayRedactions(): number {
    let removed = 0
    for (const h of this.#redactedHashes()) removed += this.#applyRedaction(h)
    return removed
  }

  #applyRedaction(targetHash: string): number {
    return this.#applyRedactionOwn(targetHash) + this.#scrubPeers(targetHash)
  }

  #applyRedactionOwn(targetHash: string): number {
    let removed = 0
    for (const seg of this.segments()) {
      const lines = fs.readFileSync(seg, 'utf-8').split('\n').filter((l) => l.trim())
      const kept: string[] = []

      for (const line of lines) {
        let rec: JournalRecord | null = null
        try {
          rec = JSON.parse(line) as JournalRecord
        } catch {
          continue // a torn line carries no content we can keep responsibly
        }
        if (rec.kind === 'memory' && rec.contentHash === targetHash) {
          removed++
          continue
        }
        kept.push(line)
      }

      if (removed === 0 && kept.length === lines.length) continue

      // Temp-and-rename in the SAME directory so the rename is atomic, then
      // fsync the directory. A rewrite that leaves a partial segment behind
      // would lose memories that were never the redaction target.
      const tmp = `${seg}.tmp-redact`
      fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '')
      const fd = fs.openSync(tmp, 'r')
      try {
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, seg)
    }

    const dir = fs.openSync(this.#dir, 'r')
    try {
      fs.fsyncSync(dir)
    } finally {
      fs.closeSync(dir)
    }

    return removed
  }
}
