-- Cortex graph schema — SQLite (better-sqlite3) backend.
--
-- Faithful translation of the Kuzu schema (see
-- docs/superpowers/research/2026-06-02-map-schema.md for the source-of-truth
-- Kuzu DDL, and docs/superpowers/research/2026-06-02-sqlite-backend-blueprint.md
-- §1 for the design). Conventions:
--   * All Kuzu PKs were STRING → TEXT PRIMARY KEY (1:1 identity, no autoincrement).
--   * Kuzu BOOLEAN → INTEGER 0/1 (callers coerce back to true/false).
--   * Kuzu INT64 (epoch ms timestamps, counts) → INTEGER.
--   * Kuzu DOUBLE → REAL.
--   * No FK constraints on edge endpoints — Kuzu had none (naming-convention
--     only) and the codebase tolerates + prunes dangling edges. Indexes, not FKs.
--   * Everything IF NOT EXISTS — idempotent on every boot, like the Kuzu initSchema.
--
-- The 8 Kuzu node tables + 14 rel tables collapse to: one `entries` supertype
-- (the Entry kind-discriminated table), `symbols` (distinct shape/lifecycle),
-- the id-joined specialization side-tables (`pattern_meta`, `session_meta`,
-- `observation_meta`), `graph_heads`, `bus_messages`, and one unified `edges`
-- table carrying all 14 relation types under a `rel` discriminator.

-- ── entries: the Entry supertype (memory|decision|pattern|concept|tool|file|session|agent|observation) ──
CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT '',
  scope         TEXT NOT NULL DEFAULT '',
  updatedAt     INTEGER NOT NULL DEFAULT 0,   -- INT64 epoch ms
  syncedAt      INTEGER NOT NULL DEFAULT 0,
  authorship    TEXT NOT NULL DEFAULT '',
  outcome       TEXT NOT NULL DEFAULT '',
  outcome_text  TEXT NOT NULL DEFAULT '',
  agent_id      TEXT NOT NULL DEFAULT '',
  session_id    TEXT NOT NULL DEFAULT '',
  machine       TEXT NOT NULL DEFAULT '',
  pinned        INTEGER NOT NULL DEFAULT 0,   -- BOOLEAN as 0/1
  engagement    INTEGER NOT NULL DEFAULT 0,   -- BOOLEAN as 0/1; promotes feedback to the managed CLAUDE.md block
  content_hash  TEXT NOT NULL DEFAULT '',     -- sha256 of raw file bytes; the change signal for re-upsert (NOT mtime)
  embedding     BLOB                          -- optional; NULL = use sidecar (vectors.bin)
);
CREATE INDEX IF NOT EXISTS idx_entries_kind         ON entries(kind);
CREATE INDEX IF NOT EXISTS idx_entries_scope        ON entries(scope);
CREATE INDEX IF NOT EXISTS idx_entries_updated      ON entries(updatedAt DESC);
CREATE INDEX IF NOT EXISTS idx_entries_synced       ON entries(syncedAt DESC);
CREATE INDEX IF NOT EXISTS idx_entries_machine      ON entries(machine);
CREATE INDEX IF NOT EXISTS idx_entries_kind_updated ON entries(kind, updatedAt DESC);

-- ── pattern_meta: Pattern specialization (id == entries.id) ──
CREATE TABLE IF NOT EXISTS pattern_meta (
  id           TEXT PRIMARY KEY,
  tool         TEXT,
  fail_args    TEXT,
  success_args TEXT,
  error_text   TEXT,
  fingerprint  TEXT
);
CREATE INDEX IF NOT EXISTS idx_pattern_fingerprint ON pattern_meta(fingerprint);

-- ── session_meta: Session lifecycle + bus presence (migrations 0003/0008/0011) ──
-- Standalone-keyed: sessions are created via the bus, not always via an Entry row.
CREATE TABLE IF NOT EXISTS session_meta (
  id                  TEXT PRIMARY KEY,
  started_at          INTEGER DEFAULT 0,
  ended_at            INTEGER DEFAULT 0,
  turns_count         INTEGER DEFAULT 0,
  files_touched_count INTEGER DEFAULT 0,
  tools_used_count    INTEGER DEFAULT 0,
  final_state         TEXT DEFAULT '',
  auto_named          INTEGER DEFAULT 0,
  -- bus columns (migration 0008 / 0011):
  friendly_name       TEXT DEFAULT '',
  cwd                 TEXT DEFAULT '',
  machine             TEXT DEFAULT '',
  title               TEXT DEFAULT '',
  last_seen           INTEGER DEFAULT 0,
  status              TEXT DEFAULT '',
  supersedes          TEXT DEFAULT '',
  meta_id             TEXT DEFAULT '',
  name_history        TEXT DEFAULT '',
  cadence_s           INTEGER NOT NULL DEFAULT 0,  -- watcher heartbeat cadence (s); 0 = no bounded heartbeat
  -- mandate-in-presence (Item 1, migration 0012): runtime coordinator-assigned orchestration state.
  --   availability: '' (not in pool) | 'available' (opted in via /available) | 'assigned'
  --   mandate: free-form 'role: scope' the coordinator handed off (derived from the dispatch by default)
  --   assigned_by / assigned_ref: provenance anchor = assigner metaId + dispatch msg id. READ-ONLY
  --     provenance for the antibody — NEVER a routing/dedup/addressing key (guardrail 2). Self-stamped
  --     on pickup, cleared on done. Never an input to classifyTrust (g1) and never widens override (g3).
  availability        TEXT NOT NULL DEFAULT '',
  mandate             TEXT NOT NULL DEFAULT '',
  assigned_by         TEXT NOT NULL DEFAULT '',
  assigned_ref        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_session_last_seen ON session_meta(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_session_meta_id   ON session_meta(meta_id);

-- ── thread_claims: which live SESSION is on a `thread` node (s2 resume) ──
-- Links a thread (entries.id, kind='thread') to the session_id working it —
-- distinct from owner_machine (which MACHINE owns the work, on the thread node).
-- Append-only so lineage is preserved (claimed_at / released_at never
-- overwritten). The OPEN claim has released_at = 0. A claim is ACTIVE only while
-- its session is present on the bus (presenceStatus live|idle); it LAPSES to
-- pending when the session goes stale / signs off (computed at read time, not
-- stored). The graceful hand-off (s2b) layers on top of this.
CREATE TABLE IF NOT EXISTS thread_claims (
  thread_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  claimed_at  INTEGER NOT NULL DEFAULT 0,
  released_at INTEGER NOT NULL DEFAULT 0,
  -- mode-on-claim (#89): the live claim's work mode for PostCompact resume —
  -- 'working' | 'quiesced' | 'waiting-on:<predicate>'. Attribute of the OPEN
  -- claim (dies at release); re-evaluated from ground truth on resume.
  mode        TEXT NOT NULL DEFAULT 'working'
);
CREATE INDEX IF NOT EXISTS idx_thread_claims_thread ON thread_claims(thread_id);

-- ── sync_manifest: per-file (mtime,size) so an all-skip sync skips re-reading ──
-- The sync pre-pass used to read + sha256 EVERY memory file each run just to
-- detect change (~4s of /mnt-WSL small-file IO at ~2.5k files). This sidecar
-- lets it SKIP opening a file whose (mtime,size) matches the last sync; the
-- content_hash on `entries` stays the AUTHORITATIVE upsert signal for the files
-- it does open, so a mtime-preserving content edit is still caught when stat
-- changes. Isolated + droppable — never touches the hot `entries` schema.
CREATE TABLE IF NOT EXISTS sync_manifest (
  path  TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL DEFAULT 0,
  size  INTEGER NOT NULL DEFAULT 0,
  ctime INTEGER  -- #146: nullable; NULL on a legacy row forces a one-time re-read
);

-- ── observation_meta: Observation specialization (id == entries.id) ──
CREATE TABLE IF NOT EXISTS observation_meta (
  id             TEXT PRIMARY KEY,
  trend          TEXT DEFAULT '',
  evidence_count INTEGER DEFAULT 0,
  first_observed INTEGER DEFAULT 0,
  last_observed  INTEGER DEFAULT 0,
  observer       TEXT DEFAULT '',
  pinned         INTEGER DEFAULT 0
);

-- Profile facets: the AI's evidence-grounded PERCEPTION of the human.
-- One row per (dimension, facet_key, stance); contradictory stances share a competing_group.
-- source='observed' facets are inferred from behavior (NOT human-editable); source='declared'
-- facets are user-seeded at onboarding and decay faster, overtaken once behavior corroborates.
CREATE TABLE IF NOT EXISTS profile_facet_meta (
  id              TEXT PRIMARY KEY,   -- == entries.id (kind='profile_facet')
  dimension       TEXT NOT NULL DEFAULT '',
  facet_key       TEXT NOT NULL DEFAULT '',
  stance          TEXT NOT NULL DEFAULT '',
  valence         TEXT NOT NULL DEFAULT 'neutral',  -- like|dislike|trait|neutral
  competing_group TEXT NOT NULL DEFAULT '',         -- dimension:facet_key
  confidence      REAL NOT NULL DEFAULT 0,
  trend           TEXT NOT NULL DEFAULT 'stable',   -- stable|strengthening|weakening|stale
  evidence_count  INTEGER NOT NULL DEFAULT 0,       -- distinct corroborating sessions
  first_observed  INTEGER NOT NULL DEFAULT 0,
  last_observed   INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'observed'  -- observed | declared (user-seeded at onboarding)
);
CREATE INDEX IF NOT EXISTS idx_profile_facet_group ON profile_facet_meta(competing_group);

-- Synthesized "about the human" narrative is a single entry (kind='profile_narrative',
-- id='profile_narrative:user'); its prose lives in entries.content. No side table needed.

-- ── edges: all 14 Kuzu relation tables collapsed under a `rel` discriminator ──
-- rel ∈ LINKS_TO | MENTIONS_FILE | MENTIONS_TOOL | RESOLVES | CONTRADICTS |
--       OCCURRED_IN | AUTHORED_BY | EVOLVED_INTO | DERIVED_FROM |
--       CALLS | IMPORTS | EXTENDS | IMPLEMENTS | REFERENCES | ABOUT |
--       SURFACED_IN  (s1 surfacings log: memory→session; weight=surface count,
--                     notedAt=last-surfaced-at. OBSERVATIONAL — survives the
--                     re-upsert wipe, see OBSERVATIONAL_RELS in sync.ts.) |
--       GROUPS  (now-slice: thread→member memory; DECLARED, re-derived from
--               thread.state.links ONLY by deriveThreadEdgesForChanged — NOT
--               from memory-body [[thread:]] backrefs; links-only keeps the edge
--               thread-owned (src=thread) so a member re-upsert can't wipe it.
--               NOT observational, so wiped+rebuilt on the thread's re-upsert.)
-- Composite PK gives free idempotency (INSERT OR IGNORE/REPLACE). Entry and
-- symbol edges share this table — ids never collide (symbol ids are qualified).
CREATE TABLE IF NOT EXISTS edges (
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  rel        TEXT NOT NULL,
  label      TEXT DEFAULT '',    -- LINKS_TO.label
  weight     REAL DEFAULT 1.0,   -- MENTIONS_FILE / MENTIONS_TOOL.weight
  confidence REAL DEFAULT 1.0,   -- RESOLVES.confidence
  notedAt    INTEGER DEFAULT 0,  -- CONTRADICTS / EVOLVED_INTO / SURFACED_IN / EDITED_IN = last-at
  provenance TEXT,               -- MENTIONS_FILE linkage §2: frontmatter|derived (NULL=legacy⇒frontmatter)
  firstAt    INTEGER DEFAULT 0,  -- s3: first-observed-at for OBSERVATIONAL rels; set on INSERT, NEVER bumped by ON CONFLICT (D3 needs first-surfaced-at, not last)
  PRIMARY KEY (src, dst, rel)
);
CREATE INDEX IF NOT EXISTS idx_edges_src_rel ON edges(rel, src);
CREATE INDEX IF NOT EXISTS idx_edges_dst_rel ON edges(rel, dst);

-- ── symbols: code graph (distinct shape + lifecycle; qualified PK) ──
CREATE TABLE IF NOT EXISTS symbols (
  id               TEXT PRIMARY KEY,   -- ${machine}@${branch}::${repo:file#name}
  name             TEXT DEFAULT '',
  symbolKind       TEXT DEFAULT '',
  repo             TEXT DEFAULT '',
  file             TEXT DEFAULT '',
  lang             TEXT DEFAULT '',
  line             INTEGER DEFAULT 0,
  signature        TEXT DEFAULT '',
  base             REAL DEFAULT 1.0,
  stickiness       REAL DEFAULT 0.0,
  centrality       INTEGER DEFAULT 0,
  lastSeen         INTEGER DEFAULT 0,
  pinned           INTEGER DEFAULT 0,
  groundTruthValid INTEGER DEFAULT 1,
  syncedAt         INTEGER DEFAULT 0,
  machine          TEXT DEFAULT '',
  root             TEXT DEFAULT '',
  branch           TEXT DEFAULT '',
  commitSha        TEXT DEFAULT '',
  dirty            INTEGER DEFAULT 0,
  extractedAt      INTEGER DEFAULT 0,
  naturalId        TEXT DEFAULT ''     -- repo:file#name (unqualified)
);
CREATE INDEX IF NOT EXISTS idx_symbols_repo_branch_machine ON symbols(repo, branch, machine);
CREATE INDEX IF NOT EXISTS idx_symbols_naturalId           ON symbols(naturalId);
CREATE INDEX IF NOT EXISTS idx_symbols_file                ON symbols(repo, branch, machine, file);
CREATE INDEX IF NOT EXISTS idx_symbols_centrality          ON symbols(centrality DESC);
CREATE INDEX IF NOT EXISTS idx_symbols_machine             ON symbols(machine);

-- ── graph_heads: per-repo extraction provenance ──
CREATE TABLE IF NOT EXISTS graph_heads (
  id          TEXT PRIMARY KEY,
  repo        TEXT,
  branch      TEXT,
  machine     TEXT,
  commitSha   TEXT,
  dirty       INTEGER DEFAULT 0,
  dirtyFiles  TEXT DEFAULT '',
  baseBranch  TEXT DEFAULT '',
  extractedAt INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_heads_rbm ON graph_heads(repo, branch, machine);

-- ── bus_messages: session-to-session messages (migration 0008 / 0011 orig_to) ──
-- Mesh transport (Milestone 2) adds origin_node + mesh_seq: every locally-
-- originated message is stamped with this node's id + a per-node monotonic seq,
-- so peers can durable-catch-up "everything you originated since my cursor".
CREATE TABLE IF NOT EXISTS bus_messages (
  id           TEXT PRIMARY KEY,
  from_session TEXT,
  from_name    TEXT,
  to_addr      TEXT,
  kind         TEXT,
  ref          TEXT,
  body         TEXT,
  created_at   INTEGER DEFAULT 0,
  delivered_to TEXT DEFAULT '',
  acked_by     TEXT DEFAULT '',
  status       TEXT DEFAULT '',
  orig_to      TEXT DEFAULT '',
  origin_node  TEXT NOT NULL DEFAULT '',
  mesh_seq     INTEGER NOT NULL DEFAULT 0,
  -- Provenance trust root (m2m node-trust): 1 iff this row entered THIS node's
  -- store via the token-authed mesh ingest boundary (ingestMeshMessage). Locally
  -- created / API rows are always 0. Server-asserted; never client-settable.
  mesh_verified INTEGER NOT NULL DEFAULT 0,
  -- humanProvenance (m2m node-trust, stage 2): 1 iff a HUMAN directed this send.
  -- Honor-system marker carried VERBATIM (NOT server-asserted) — meaningful only
  -- when combined with a trusted source (trust=local|mesh); on a trusted node it
  -- = the human's direct instruction. Legacy/unset rows default 0, so guidance
  -- never treats an old/agent message as a human directive.
  human_provenance INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bus_to_addr ON bus_messages(to_addr, created_at);
CREATE INDEX IF NOT EXISTS idx_bus_from    ON bus_messages(from_session);
CREATE INDEX IF NOT EXISTS idx_msg_origin_seq ON bus_messages(origin_node, mesh_seq);

-- ── mesh_cursors: per-peer catch-up offset (last mesh_seq ingested FROM peer) ──
CREATE TABLE IF NOT EXISTS mesh_cursors (
  peer_node  TEXT PRIMARY KEY,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- ── mesh_seq_counter: this node's monotonic originate-sequence (per node id) ──
CREATE TABLE IF NOT EXISTS mesh_seq_counter (
  node TEXT PRIMARY KEY,
  seq  INTEGER NOT NULL DEFAULT 0
);

-- M4 live memory propagation: replication LOG (memories themselves stay .md + entries;
-- this table is bookkeeping for emit/backfill + a content snapshot for offline catch-up).
CREATE TABLE IF NOT EXISTS mem_log (
  id           TEXT PRIMARY KEY,         -- == entries.id / memory id
  repo_path    TEXT NOT NULL DEFAULT '', -- e.g. memory/user/foo.md (private-mind repo layout)
  scope        TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT '', -- full .md snapshot (frontmatter + body)
  content_hash TEXT NOT NULL DEFAULT '',
  machine      TEXT NOT NULL DEFAULT '', -- lineage (origin author machine)
  origin_node  TEXT NOT NULL DEFAULT '', -- mesh node that originated this version
  mem_seq      INTEGER NOT NULL DEFAULT 0,
  deleted_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mem_origin_seq ON mem_log(origin_node, mem_seq);
CREATE TABLE IF NOT EXISTS mem_cursors (
  peer_node  TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mem_seq_counter ( node TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0 );

-- Maps a host's superseded/historical node ids onto its current canonical id, so
-- pre-churn memories/AST/sessions roll up to one node. Read-time only; graph
-- lineage columns (entries.machine, symbols.machine, session_meta.machine) are
-- never rewritten. Seeded once by seedNodeAliases.ts.
CREATE TABLE IF NOT EXISTS node_aliases (
  alias_id     TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL
);

-- ── codegraph_prefs: per-repo Code-view display preferences ──
-- default_branch pins which branch the whole-repo symbol graph shows by default.
-- Git doesn't enforce main vs master vs develop, so the displayed branch is a
-- user choice; without a pin the viz auto-resolves the richest branch. Keyed by
-- repo (a repo's canonical branch doesn't vary by machine). Read by
-- displaySymbolBranch; written via /api/graph/symbols/default-branch.
CREATE TABLE IF NOT EXISTS codegraph_prefs (
  repo           TEXT PRIMARY KEY,
  default_branch TEXT NOT NULL,
  updated_at     INTEGER NOT NULL DEFAULT 0
);
