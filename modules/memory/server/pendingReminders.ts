/**
 * Reminders a Stop hook would once have held the turn for. Claude Code shows a
 * held Stop as a hook error, so they wait here, one per key per session, and
 * the next prompt for that session carries them.
 */
import fs from 'node:fs'
import path from 'node:path'

const file = (dataDir: string, session: string) => path.join(dataDir, 'pending-reminders', `${session.replace(/[^\w-]/g, '_')}.json`)

const read = (f: string): Record<string, string> => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, string>
  } catch {
    return {}
  }
}

/** A later Stop with the same key replaces the earlier text: only the latest is worth saying. */
export const addReminder = (dataDir: string, session: string, key: string, text: string) => {
  const f = file(dataDir, session)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ ...read(f), [key]: text }))
}

/** The session's pending reminders, removed as they are read so each is delivered once. */
export const takeReminders = (dataDir: string, session: string): string[] => {
  const f = file(dataDir, session)
  const pending = Object.values(read(f))
  fs.rmSync(f, { force: true })
  return pending
}
