/**
 * Dialogue feeds: how a module that carries conversation outside a session
 * transcript (an operator on a chat bot, sessions talking over the bus) makes it
 * available, without knowing who reads it.
 *
 * A module with `"dialogue": true` in its manifest appends records to
 * `<dataRoot>/<module>/dialogue/<writer>.ndjson`. Each writing process uses its
 * own file (`writer`), so two processes never interleave lines in one file.
 * Records are append-only; a reader keeps its own cursor per file.
 */
import fs from 'node:fs'
import path from 'node:path'

import { dataRoot } from './paths.js'

export type DialogueParty = { kind: 'operator' | 'member' | 'role'; name: string }

export type DialogueRecord = {
  v: 1
  /** Unique within the feed; a reader may see a record twice and must apply it once. */
  id: string
  at: number
  /** What carried it: a short name such as `telegram` or `bus`. */
  source: string
  from: DialogueParty
  to: DialogueParty
  text: string
  /** The record (or carrier message) this one answers. */
  replyTo?: string
  /** The local session member that took part, which links the record to that session. */
  member: string
  /** The carrier's own message id, when it has one (a bus message id gives relay chains). */
  ref?: string
}

export const dialogueDir = (module: string, root = dataRoot()) => path.join(root, module, 'dialogue')

/** Append records to this module's feed. Never throws: a lost dialogue line must not break the sender. */
export const appendDialogue = (module: string, writer: string, records: DialogueRecord[], root = dataRoot()): void => {
  if (!records.length) return
  try {
    const dir = dialogueDir(module, root)
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, `${writer.replace(/[^a-z0-9-]/gi, '-')}.ndjson`), records.map((r) => `${JSON.stringify(r)}\n`).join(''))
  } catch {
    /* best effort */
  }
}

/** Bus bodies that are a JSON object are protocol (a command, a command result), not dialogue. */
export const isProtocolBody = (body: string): boolean => {
  const t = body.trimStart()
  if (!t.startsWith('{')) return false
  try {
    return typeof JSON.parse(t) === 'object'
  } catch {
    return false
  }
}
