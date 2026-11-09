import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Member identity, local half.
 *
 * WHERE IDENTITY LIVES. The member name is carried in the Claude Code session's
 * custom title: the harness persists it, hands it back to SessionStart and
 * UserPromptSubmit hooks as `session_title`, and keeps it across resume and
 * compaction. So a resumed acme-dev2 is still acme-dev2 without Cortex reading
 * a transcript. (Design section 5, approved.)
 *
 * What lives HERE, on this machine, keyed by name:
 *   members/<name>.json   the members this machine has minted or adopted
 *   sessions.json         harness session id -> member name, a CACHE
 *   seen/<name>.json      message ids already delivered to that member
 *
 * The sessions cache exists because only two hook events carry the title. It is
 * rewritten at every SessionStart and UserPromptSubmit, never used as an address
 * and never sent anywhere; deleting it costs at most one unattributed event
 * between prompts.
 */

export type LocalMember = {
  name: string
  /** Random, minted with the name. Tells two sessions that minted the same name apart. */
  instance: string
  createdAt: number
}

export class LocalIdentity {
  constructor(private dir: string) {}

  private file(...parts: string[]) {
    return path.join(this.dir, ...parts)
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
    } catch {
      return fallback
    }
  }

  private writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, file)
  }

  member(name: string): LocalMember | undefined {
    const m = this.readJson<LocalMember | null>(this.file('members', `${name}.json`), null)
    return m ?? undefined
  }

  /** Mint or adopt. Adopting reuses the instance the registry already records. */
  saveMember(name: string, instance: string = crypto.randomUUID(), now = Date.now()): LocalMember {
    const existing = this.member(name)
    if (existing) return existing
    const m: LocalMember = { name, instance, createdAt: now }
    this.writeJson(this.file('members', `${name}.json`), m)
    return m
  }

  forgetMember(name: string): void {
    fs.rmSync(this.file('members', `${name}.json`), { force: true })
  }

  /**
   * A title for a session that is not a member, set by a plain rename. The
   * harness only accepts a title from a hook, so the next hook hands it over once.
   */
  setPendingTitle(sessionId: string, title: string): void {
    const map = this.readJson<Record<string, string>>(this.file('pending-titles.json'), {})
    map[sessionId] = title
    this.writeJson(this.file('pending-titles.json'), map)
  }

  takePendingTitle(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined
    const map = this.readJson<Record<string, string>>(this.file('pending-titles.json'), {})
    const title = map[sessionId]
    if (title === undefined) return undefined
    delete map[sessionId]
    this.writeJson(this.file('pending-titles.json'), map)
    return title
  }

  sessionMember(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined
    return this.readJson<Record<string, string>>(this.file('sessions.json'), {})[sessionId]
  }

  bindSession(sessionId: string | undefined, name: string): void {
    if (!sessionId) return
    const map = this.readJson<Record<string, string>>(this.file('sessions.json'), {})
    if (map[sessionId] === name) return
    map[sessionId] = name
    this.writeJson(this.file('sessions.json'), map)
  }

  seen(name: string): Set<string> {
    return new Set(this.readJson<string[]>(this.file('seen', `${name}.json`), []))
  }

  markSeen(name: string, ids: string[]): void {
    if (!ids.length) return
    const all = this.seen(name)
    for (const id of ids) all.add(id)
    this.writeJson(this.file('seen', `${name}.json`), [...all])
  }

  /** Answers a member owes elsewhere (Envelope.awaits), by key: reminded once, or answered. */
  awaits(name: string): Record<string, 'reminded' | 'answered'> {
    return this.readJson<Record<string, 'reminded' | 'answered'>>(this.file('awaits', `${name}.json`), {})
  }

  markAwait(name: string, key: string, state: 'reminded' | 'answered'): void {
    const all = this.awaits(name)
    if (all[key] === state || all[key] === 'answered') return
    all[key] = state
    this.writeJson(this.file('awaits', `${name}.json`), all)
  }
}
