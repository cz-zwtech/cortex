-- The earlier Python gateway's db.py SCHEMA (@ 86e3f0d), verbatim: the importer is tested against the real shape.

CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
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
    acked_at TEXT,
    acked_by TEXT,
    escalated_at TEXT,
    outbound_id TEXT,
    reviewed_at TEXT,
    reviewed_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS items_open_dedupe ON items(source, dedupe_key)
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
    item_id TEXT,
    sender TEXT NOT NULL,
    reply_route TEXT,
    topic TEXT,
    text TEXT NOT NULL,
    expects_reply INTEGER NOT NULL DEFAULT 1,
    idempotency_key TEXT UNIQUE,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    message_id INTEGER UNIQUE,
    answered INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    sent_at TEXT
);
CREATE INDEX IF NOT EXISTS outbound_state ON outbound(state);

CREATE TABLE IF NOT EXISTS inbound (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    update_id INTEGER UNIQUE,
    legacy_key TEXT UNIQUE,
    at TEXT NOT NULL,
    chat_id TEXT,
    from_id TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to INTEGER,
    route_to TEXT,
    topic TEXT,
    matched_by TEXT,
    claimed_by TEXT,
    claimed_at TEXT,
    notified INTEGER NOT NULL DEFAULT 0,
    notify_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS routes (
    tag TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

