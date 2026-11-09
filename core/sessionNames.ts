/**
 * Session naming, owned by core (19 Oct 2026): `/cortex-rename` works with no
 * module installed, and modules follow a rename through the `session.renamed`
 * event.
 *
 * The harness takes a title only from a SessionStart or UserPromptSubmit hook
 * (`sessionTitle`), so a rename is two steps: the CLI records it as PENDING, and
 * the next of those hooks hands it over. Core also records the title the
 * harness last reported or was given, so a title that changes with no pending
 * rename is the harness's own `/rename`, and modules follow that too.
 *
 * One file, `<state>/core/sessions.json`: the hook reads it on every event and a
 * file needs no database lock.
 */
import fs from 'node:fs'
import path from 'node:path'

export const RENAMED = 'session.renamed'

/** The `session.renamed` payload. `args` are the extra arguments modules declared (`extends`). */
export type Renamed = {
  sessionId: string
  from?: string
  to: string
  args: string[]
  force: boolean
  /** `cli`: /cortex-rename. `harness`: the user renamed the session with Claude Code itself. */
  source: 'cli' | 'harness'
}

/** What a subscriber may answer: lines for the person who renamed. */
export type RenamedResult = { lines?: string[] } | undefined

type Entry = { title?: string; pending?: string }
type File = { sessions: Record<string, Entry> }

/** Session titles: short, printable, no line breaks. Member names are stricter, and comms checks those. */
export const TITLE_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u

export class SessionNames {
  constructor(private file: string) {}

  static at(stateDir: string): SessionNames {
    return new SessionNames(path.join(stateDir, 'core', 'sessions.json'))
  }

  private read(): File {
    try {
      const f = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as File
      return f && typeof f.sessions === 'object' ? f : { sessions: {} }
    } catch {
      return { sessions: {} }
    }
  }

  private write(f: File): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(f, null, 2))
    fs.renameSync(tmp, this.file)
  }

  private update(sessionId: string, fn: (e: Entry) => Entry): void {
    const f = this.read()
    f.sessions[sessionId] = fn(f.sessions[sessionId] ?? {})
    this.write(f)
  }

  get(sessionId: string): Entry {
    return this.read().sessions[sessionId] ?? {}
  }

  /** The title to hand over at the next title-carrying hook. */
  setPending(sessionId: string, title: string): void {
    this.update(sessionId, (e) => ({ ...e, pending: title }))
  }

  /** The pending title, cleared: it is handed over once. */
  takePending(sessionId: string): string | undefined {
    const pending = this.get(sessionId).pending
    if (pending === undefined) return undefined
    this.update(sessionId, (e) => ({ title: e.title }))
    return pending
  }

  /** Record the title the session has now (reported by the harness, or just handed to it). */
  record(sessionId: string, title: string): void {
    if (this.get(sessionId).title === title) return
    this.update(sessionId, (e) => ({ ...e, title }))
  }

  /**
   * A title the harness reports that differs from the one recorded, with no
   * rename pending: the user renamed the session in Claude Code. Returns the
   * change and records it; undefined on first sight or no change.
   */
  observe(sessionId: string, reported: string | undefined): { from: string; to: string } | undefined {
    const title = reported?.trim()
    if (!title) return undefined
    const e = this.get(sessionId)
    if (e.title === undefined || e.pending !== undefined) {
      if (e.title === undefined) this.record(sessionId, title)
      return undefined
    }
    if (e.title === title) return undefined
    this.record(sessionId, title)
    return { from: e.title, to: title }
  }
}
