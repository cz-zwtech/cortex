/**
 * The audit trail (trust doc 7): every crossing, admitted, held or refused,
 * one JSON line each, hash-chained so an edited or removed line is detected.
 * Entries hold a payload hash, never a payload.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type AuditEntry = {
  dir: 'in' | 'out' | 'link' | 'config'
  peer: string
  principal?: string
  kind?: string
  decision: 'admitted' | 'sent' | 'held' | 'refused' | 'delivered' | 'read' | 'opened' | 'closed' | 'banned'
  rule: string
  payloadHash?: string
}
type Line = AuditEntry & { at: number; seq: number; prev: string; hash: string }

export const auditFile = (dir: string) => path.join(dir, 'audit.jsonl')
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
export const payloadHash = (s: string) => sha(s)
const GENESIS = '0'.repeat(64)

const lineHash = (l: Omit<Line, 'hash'>) => sha(JSON.stringify({ ...l, hash: undefined }))

/** The last line's seq and hash, read from the file's tail. */
const head = (file: string): { seq: number; hash: string } => {
  try {
    const st = fs.statSync(file)
    const len = Math.min(st.size, 64 * 1024)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, st.size - len)
    fs.closeSync(fd)
    const last = buf.toString('utf-8').trimEnd().split('\n').pop()
    if (!last) return { seq: 0, hash: GENESIS }
    const l = JSON.parse(last) as Line
    return { seq: l.seq, hash: l.hash }
  } catch {
    return { seq: 0, hash: GENESIS }
  }
}

export class Audit {
  #seq: number
  #prev: string
  constructor(
    private dir: string,
    /** Every line written, as it is written: the metrics' counters. */
    private onWrite?: (e: AuditEntry) => void,
  ) {
    const h = head(auditFile(dir))
    this.#seq = h.seq
    this.#prev = h.hash
  }

  write(e: AuditEntry, at = Date.now()): void {
    const base = { ...e, at, seq: this.#seq + 1, prev: this.#prev }
    const line: Line = { ...base, hash: lineHash(base) }
    fs.mkdirSync(this.dir, { recursive: true })
    fs.appendFileSync(auditFile(this.dir), JSON.stringify(line) + '\n')
    this.#seq = line.seq
    this.#prev = line.hash
    this.onWrite?.(e)
  }

  get head(): { seq: number; hash: string } {
    return { seq: this.#seq, hash: this.#prev }
  }
}

/** Walk the chain; the first broken line, if any. */
export const verifyAudit = (dir: string): { ok: true; lines: number } | { ok: false; line: number; why: string } => {
  let prev = GENESIS
  let n = 0
  let text = ''
  try {
    text = fs.readFileSync(auditFile(dir), 'utf-8')
  } catch {
    return { ok: true, lines: 0 }
  }
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    n++
    let l: Line
    try {
      l = JSON.parse(raw) as Line
    } catch {
      return { ok: false, line: n, why: 'not JSON' }
    }
    if (l.seq !== n) return { ok: false, line: n, why: `seq ${l.seq}, expected ${n}` }
    if (l.prev !== prev) return { ok: false, line: n, why: 'does not follow the line before it' }
    const { hash, ...rest } = l
    if (lineHash(rest) !== hash) return { ok: false, line: n, why: 'its content does not match its hash' }
    prev = hash
  }
  return { ok: true, lines: n }
}

/** Every line, parsed; a line that is not JSON is left out (verifyAudit reports it). */
export const readAudit = (dir: string): Line[] => {
  let text = ''
  try {
    text = fs.readFileSync(auditFile(dir), 'utf-8')
  } catch {
    return []
  }
  return text.split('\n').flatMap((raw) => {
    if (!raw.trim()) return []
    try {
      return [JSON.parse(raw) as Line]
    } catch {
      return []
    }
  })
}
export type AuditLine = Line
