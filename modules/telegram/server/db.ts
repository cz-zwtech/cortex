/**
 * The one durable store: items, their event trail, outbound messages, inbound
 * replies, tag routes and per-bot key/values.
 *
 * Ported from the earlier Python gateway's db.py with a `bot` column on every table, so several
 * bots share one store without sharing an offset, a thread or a dedupe key.
 * Times stay ISO strings with microseconds (`2026-10-18T10:00:00.000000Z`), the
 * format the imported rows already have, and `never` is the info sentinel.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

import { assertWritable } from './guard.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  bot TEXT NOT NULL,
  source TEXT NOT NULL,
  owner TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  dedupe_key TEXT,
  repeat_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fallback_due_at TEXT NOT NULL,
  routed_at TEXT,
  route_attempts INTEGER NOT NULL DEFAULT 0,
  next_route_at TEXT,
  unrouted_at TEXT,
  acked_at TEXT,
  acked_by TEXT,
  escalated_at TEXT,
  outbound_id TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS items_open_dedupe ON items(bot, source, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'routed');
CREATE INDEX IF NOT EXISTS items_state ON items(state);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  at TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS outbound (
  id TEXT PRIMARY KEY,
  bot TEXT NOT NULL,
  sender TEXT NOT NULL,
  reply_route TEXT,
  topic TEXT,
  text TEXT NOT NULL,
  idempotency_key TEXT,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  message_id INTEGER,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  operator TEXT
);
CREATE INDEX IF NOT EXISTS outbound_state ON outbound(state);
CREATE UNIQUE INDEX IF NOT EXISTS outbound_message ON outbound(bot, message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS outbound_idem ON outbound(bot, sender, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS inbound (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot TEXT NOT NULL,
  update_id INTEGER,
  legacy_key TEXT UNIQUE,
  at TEXT NOT NULL,
  chat_id TEXT,
  from_id TEXT NOT NULL,
  operator TEXT,
  text TEXT NOT NULL,
  reply_to INTEGER,
  route_to TEXT,
  topic TEXT,
  matched_by TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  notify_attempts INTEGER NOT NULL DEFAULT 0,
  next_notify_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS inbound_update ON inbound(bot, update_id) WHERE update_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS routes (
  bot TEXT NOT NULL,
  tag TEXT NOT NULL,
  sender TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (bot, tag)
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export const NEVER = 'never'

/** ISO with microseconds, the format the earlier gateway wrote, so imported and new rows compare as strings. */
export const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z')

/** A time string to ms, accepting both stored formats (with and without fractions); NaN when it is not a time. */
export const parseTime = (s: string): number => Date.parse(s)

export const newId = (prefix: 'it' | 'ob'): string => `${prefix}_${crypto.randomBytes(6).toString('hex')}`

export type Db = Database.Database

/**
 * Columns added after the first release (21 Oct, two-way replies): the operator message's own Telegram id,
 * so an answer can thread onto it; whether it still awaits an answer; and the outbound that answered it.
 */
const migrate = (db: Database.Database) => {
  const has = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
  const inbound = has('inbound')
  if (!inbound.has('message_id')) db.exec('ALTER TABLE inbound ADD COLUMN message_id INTEGER')
  if (!inbound.has('awaiting')) db.exec('ALTER TABLE inbound ADD COLUMN awaiting INTEGER NOT NULL DEFAULT 0')
  if (!inbound.has('answered_by')) db.exec('ALTER TABLE inbound ADD COLUMN answered_by TEXT')
  if (!has('outbound').has('reply_to_inbound')) db.exec('ALTER TABLE outbound ADD COLUMN reply_to_inbound INTEGER')
}

export const openDb = (file: string): Db => {
  assertWritable(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 10000')
  db.exec(SCHEMA)
  migrate(db)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* not ours to change; the data dir is already private */
  }
  return db
}

/** BEGIN IMMEDIATE, as the earlier gateway's Tx: a writer takes the lock before it reads what it will change. */
export const tx = <T>(db: Db, fn: () => T): T => db.transaction(fn).immediate()

export const event = (db: Db, itemId: string, at: string, from: string | null, to: string, actor: string, note?: string | null): void => {
  db.prepare('INSERT INTO events(item_id, at, from_state, to_state, actor, note) VALUES (?, ?, ?, ?, ?, ?)').run(itemId, at, from, to, actor, note ?? null)
}

export const kvGet = (db: Db, key: string): string | undefined =>
  (db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value

export const kvSet = (db: Db, key: string, value: string | number): void => {
  db.prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
}

export const kvDel = (db: Db, key: string): void => {
  db.prepare('DELETE FROM kv WHERE key = ?').run(key)
}

export const kvIncr = (db: Db, key: string): void => {
  kvSet(db, key, Number(kvGet(db, key) ?? 0) + 1)
}
