/**
 * File transfer over routed delivery (mesh design R14 and section 10).
 *
 * Decisions: files and folders, up to about 100 MB per file; chunked,
 * resuming from the last good chunk; multi-hop like messages, streamed through
 * relays that store nothing; messages before file chunks; SHA-256 per chunk
 * and per file, reported in DELIVERED; received into a per-mailbox inbox,
 * never overwriting; run through the secret gate; never executed.
 *
 *   origin                                destination
 *   file-offer {entries, address, body} →
 *                                       ← file-need {need: chunks held per entry}
 *   chunk {entry, n, data, sha256}      →   (verified, appended to staging)
 *                                       ← file-progress {entry, upto}
 *   ... a small window of chunks in flight per transfer ...
 *                                       ← delivered {sha256s}  (all verified, scanned, in the inbox)
 *                                       ← read                 (a session was shown it)
 *
 * The origin keeps a snapshot of what it sent, so later edits to the source
 * change nothing and a broken transfer can resume. It goes on READ. The
 * destination's staging survives restarts, so a resume asks only for what is
 * missing; a file whose whole-file hash fails starts that file again.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const CHUNK = 256 * 1024
/** Chunks in flight per transfer: small, so a message never waits long behind a file. */
export const WINDOW = 4
export const fileMaxBytes = (env: NodeJS.ProcessEnv = process.env) => Number(env.CKN_MESH_FILE_MAX_MB ?? 100) * 1024 * 1024
/** A transfer with no progress for this long is offered again, and resumes. */
const STALL_MS = 5_000

export type FileEntry = { name: string; size: number; sha256: string; chunks: number }
export type SavedFile = { name: string; path: string; size: number; sha256: string }

export const chunksOf = (size: number) => Math.max(1, Math.ceil(size / CHUNK))
export const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex')
export const sha256File = (file: string) => sha256(fs.readFileSync(file))

/** A relative path that stays inside its folder: no absolute paths, no `..`. */
export const safeName = (name: string): boolean =>
  !!name && !path.isAbsolute(name) && !name.split(/[\\/]/).some((p) => p === '..' || p === '') && !name.includes('\0')

/**
 * Snapshot files and folders into `dir` for sending. Folders keep their
 * structure under their own name. Refuses anything over the size limit, before
 * anything is sent.
 */
export const snapshot = (sources: string[], dir: string, max = fileMaxBytes()): FileEntry[] => {
  const entries: FileEntry[] = []
  const add = (src: string, name: string) => {
    const st = fs.statSync(src)
    if (st.isDirectory()) {
      for (const child of fs.readdirSync(src).sort()) add(path.join(src, child), path.join(name, child))
      return
    }
    if (!st.isFile()) return
    if (st.size > max) throw new Error(`${name} is ${Math.round(st.size / 1048576)} MB, over the ${Math.round(max / 1048576)} MB limit`)
    const dest = path.join(dir, name)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    const data = fs.readFileSync(dest)
    entries.push({ name, size: data.length, sha256: sha256(data), chunks: chunksOf(data.length) })
  }
  fs.mkdirSync(dir, { recursive: true })
  for (const s of sources) add(path.resolve(s), path.basename(path.resolve(s)))
  if (!entries.length) throw new Error('nothing to send: no files found')
  return entries
}

/** A name that does not exist yet in `dir`: "brief.md", then "brief (1).md". */
export const freeName = (dir: string, name: string): string => {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  for (let i = 1; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem} (${i})${ext}`
  return candidate
}

// ── origin ─────────────────────────────────────────────────────────────────

type Outgoing = { dir: string; entries: FileEntry[]; acked: number[]; next: number[]; lastProgress: number; offered: number; ready: boolean }

export type ChunkFrame = { entry: number; n: number; data: string; sha256: string }

/** What the origin tracks while a transfer is running. Rebuilt from the snapshot after a restart. */
export class Outbound {
  #t = new Map<string, Outgoing>()

  /** Start or restart (resume) a transfer: an offer goes out, and the destination says what it lacks. */
  offerDue(id: string, dir: string, entries: FileEntry[], now: number): boolean {
    const t = this.#t.get(id)
    if (t && now - Math.max(t.lastProgress, t.offered) < STALL_MS) return false
    this.#t.set(id, { dir, entries, acked: entries.map(() => 0), next: entries.map(() => 0), lastProgress: 0, offered: now, ready: false })
    return true
  }

  need(id: string, need: number[], now: number): void {
    const t = this.#t.get(id)
    if (!t) return
    t.acked = t.entries.map((_, i) => Math.min(need[i] ?? 0, t.entries[i]!.chunks))
    t.next = [...t.acked]
    t.lastProgress = now
    t.ready = true
  }

  progress(id: string, entry: number, upto: number, now: number): void {
    const t = this.#t.get(id)
    if (!t || entry >= t.entries.length) return
    if (upto < t.acked[entry]!) t.next[entry] = upto // the destination restarted this file (bad whole-file hash)
    t.acked[entry] = upto
    t.next[entry] = Math.max(t.next[entry]!, upto)
    t.lastProgress = now
  }

  /** Chunks to send now, entry by entry, never more than WINDOW unacknowledged. */
  due(id: string): ChunkFrame[] {
    const t = this.#t.get(id)
    if (!t?.ready) return [] // nothing before the destination says what it already holds
    const out: ChunkFrame[] = []
    const i = t.entries.findIndex((e, k) => t.acked[k]! < e.chunks)
    if (i < 0) return out
    const e = t.entries[i]!
    const fd = fs.openSync(path.join(t.dir, e.name), 'r')
    try {
      while (t.next[i]! < e.chunks && t.next[i]! - t.acked[i]! < WINDOW) {
        const n = t.next[i]!
        const buf = Buffer.alloc(Math.min(CHUNK, e.size - n * CHUNK))
        fs.readSync(fd, buf, 0, buf.length, n * CHUNK)
        out.push({ entry: i, n, data: buf.toString('base64'), sha256: sha256(buf) })
        t.next[i] = n + 1
      }
    } finally {
      fs.closeSync(fd)
    }
    return out
  }

  done(id: string): void {
    this.#t.delete(id)
  }

  /** A link went down: chunks in flight may be lost, so every transfer is offered again now. */
  stallAll(): void {
    for (const t of this.#t.values()) {
      t.lastProgress = 0
      t.offered = 0
    }
  }

  active(): string[] {
    return [...this.#t.keys()]
  }
}

// ── destination ────────────────────────────────────────────────────────────

type Staging = { entries: FileEntry[]; received: number[]; address: string; body: string }

/** Staging for incoming transfers, on disk so a restart resumes rather than starts over. */
export class Inbound {
  constructor(private root: string) {}

  #dir(origin: string, id: string) {
    return path.join(this.root, 'in', origin.replace(/[^A-Za-z0-9._-]/g, '_'), id.replace(/[^A-Za-z0-9._-]/g, '_'))
  }

  #load(origin: string, id: string): Staging | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.#dir(origin, id), 'staging.json'), 'utf-8')) as Staging
    } catch {
      return undefined
    }
  }

  #save(origin: string, id: string, s: Staging): void {
    const file = path.join(this.#dir(origin, id), 'staging.json')
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(s))
    fs.renameSync(`${file}.tmp`, file)
  }

  /** An offer: stage it (or pick up an earlier one) and say how many chunks of each file are held. */
  offer(origin: string, id: string, entries: FileEntry[], address: string, body: string): number[] {
    const dir = this.#dir(origin, id)
    fs.mkdirSync(dir, { recursive: true })
    const prior = this.#load(origin, id)
    if (prior && JSON.stringify(prior.entries) === JSON.stringify(entries)) return prior.received
    const s: Staging = { entries, received: entries.map(() => 0), address, body }
    for (let i = 0; i < entries.length; i++) fs.writeFileSync(path.join(dir, `${i}.part`), '')
    this.#save(origin, id, s)
    return s.received
  }

  /**
   * A chunk. Accepted only in order and only if its hash matches; then the
   * file grows by it. Returns how many chunks of that file are now held, and
   * whether the whole transfer is complete and verified. A file whose
   * whole-file hash fails is emptied and asked for again from its first chunk.
   */
  chunk(origin: string, id: string, c: ChunkFrame): { upto: number; complete: boolean } | undefined {
    const s = this.#load(origin, id)
    const e = s?.entries[c.entry]
    if (!s || !e) return undefined
    const part = path.join(this.#dir(origin, id), `${c.entry}.part`)
    const data = Buffer.from(c.data, 'base64')
    if (c.n === s.received[c.entry] && sha256(data) === c.sha256) {
      fs.appendFileSync(part, data)
      s.received[c.entry] = c.n + 1
      if (s.received[c.entry] === e.chunks && sha256File(part) !== e.sha256) {
        fs.writeFileSync(part, '')
        s.received[c.entry] = 0
      }
      this.#save(origin, id, s)
    }
    return { upto: s.received[c.entry]!, complete: s.entries.every((x, i) => s.received[i] === x.chunks) }
  }

  /** The verified files of a complete transfer, where they are staged. */
  staged(origin: string, id: string): { staging: Staging; files: { entry: FileEntry; part: string }[] } | undefined {
    const s = this.#load(origin, id)
    if (!s) return undefined
    return { staging: s, files: s.entries.map((entry, i) => ({ entry, part: path.join(this.#dir(origin, id), `${i}.part`) })) }
  }

  drop(origin: string, id: string): void {
    fs.rmSync(this.#dir(origin, id), { recursive: true, force: true })
  }
}

/** Where a mailbox's files land: inbox/<role>/, inbox/members/<member>/, or on a gateway inbox/gate/<domain>/<role>/. */
export const inboxDirFor = (root: string, address: string): string => {
  const g = /^gate:([a-z0-9][a-z0-9.-]*):([a-z0-9][a-z0-9-]*)$/.exec(address)
  if (g) return path.join(root, 'inbox', 'gate', g[1]!, g[2]!)
  const m = /^cortex-comms:(role|member):([a-z][a-z0-9-]*)$/.exec(address)
  if (!m) throw new Error(`not a comms mailbox: ${address}`)
  return m[1] === 'role' ? path.join(root, 'inbox', m[2]!) : path.join(root, 'inbox', 'members', m[2]!)
}

/** Move a complete, verified transfer into its inbox, never overwriting. */
export const moveIntoInbox = (root: string, address: string, files: { entry: FileEntry; part: string }[]): SavedFile[] => {
  const base = inboxDirFor(root, address)
  // A folder sent twice lands twice, beside itself, rather than merging into the first.
  const tops = new Map<string, string>()
  const saved: SavedFile[] = []
  for (const { entry, part } of files) {
    const [top, ...rest] = entry.name.split(/[\\/]/)
    if (!tops.has(top!)) {
      fs.mkdirSync(base, { recursive: true })
      tops.set(top!, freeName(base, top!))
    }
    const dest = path.join(base, tops.get(top!)!, ...rest)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(part, dest)
    saved.push({ name: entry.name, path: dest, size: entry.size, sha256: entry.sha256 })
  }
  return saved
}

/**
 * The secret gate for a received file (F7), around a text scanner that
 * returns what it found (never the values). A binary file (a NUL in its first
 * 8 KB) cannot be judged as text and passes; received files are never executed.
 */
export const gateFile = (scanText: (text: string) => string[]) => (file: string): string | undefined => {
  const data = fs.readFileSync(file)
  if (data.subarray(0, 8192).includes(0)) return undefined
  const found = scanText(data.toString('utf-8'))
  return found.length ? `refused by the secret gate: it looks like it holds ${[...new Set(found)].join(', ')}` : undefined
}
