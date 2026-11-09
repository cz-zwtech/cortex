-- Memory module schema.
--
-- Designed on its merits, not inherited. V1 adoption is a Phase 8 question and
-- this file owes it nothing.
--
-- Three structural decisions carry most of the weight:
--
--   1. MEMORIES AND HUBS ARE DIFFERENT TABLES.
--      V1 put both in `entries` and separated them with a `kind NOT IN
--      ('file','tool','thread',...)` filter repeated in four places — and the
--      two subsystems disagreed about `thread` in production (decay treated it
--      as a memory, recall as a hub). The distinction that actually matters is
--      "does this node carry authored content", so it is structural here and
--      cannot drift.
--
--      A THREAD IS A MEMORY. It carries content, is file-backed, decays when
--      done, and is resumable — the product promise. It is suppressed from
--      ordinary recall results because a query wants its members, not the
--      anchor, and THAT IS A RESULTS POLICY, not a taxonomy fact. Suppression
--      lives in ranking, not here.
--
--   2. EDGES ARE THREE STORES, NOT ONE TABLE WITH A CARVE-OUT.
--      Declared / observed / derived have different ownership and different
--      lifetimes. V1 kept them in one table and preserved the difference with a
--      NOT-IN list on delete plus a hand-maintained filter — an invariant that
--      had to be remembered at every write site, and was guarded by four
--      independent tests, which is the tell that the design never enforced it.
--      Here the lifetime IS the table.
--
--   3. NO EMBEDDING COLUMN. Vectors live in a sidecar. V1 declared
--      `entries.embedding` and never read or wrote it; two independent
--      investigations found it dead from opposite directions.

-- ─────────────────────────────────────────────────────────────────────────────
-- Memories: everything with authored content.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,

  -- PROVENANCE, NOT IDENTITY. Where this text most recently arrived from.
  --
  -- This column asserted "stable identity" until the first-class-memory charter
  -- un-earned the property: a memory `.md` is a write-inbox that empties on
  -- ingest, so the path is a MAILBOX rather than an address, and the next write
  -- to it is a different memory. Identity is the graph id, decided by the
  -- reconcile ladder; slug and content-hash are matching SIGNALS, never keys.
  --
  -- Full provenance history is deliberately NOT a table here — the journal
  -- holds every arrival with its path, machine and timestamp.
  source        TEXT NOT NULL,

  -- THE POINTER BACK TO THE DURABLE RECORD THIS ROW DERIVES FROM.
  --
  -- The journal is the source of truth and this table is a derived view, but
  -- until this column existed the view could not ADDRESS its own source. Three
  -- different hashes are in play and none of them linked the two:
  --
  --   journal record   sha256(full text, frontmatter included)
  --   body hash        sha256(body) — the consume ledger and the ladder
  --   this row's hash  sha256 over name, description and body together
  --
  -- The consequence was concrete: `memory.delete` could remove a row but could
  -- not tombstone the record it came from, so `journal.replay()` would resurrect
  -- it — deletion that a rebuild undoes is not deletion. Attempting it with this
  -- row's own `content_hash` silently matched nothing, which is the SAME trap as
  -- reading a hash computed over more fields than the question asks about.
  --
  -- Nullable: rows written before this column existed, and any adopted from a
  -- peer, legitimately have no local journal record to point at.
  journal_hash  TEXT,

  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '',

  -- Axis 2 — what SHAPE of memory. The real vocabulary, owned by this module.
  -- decision | error | workflow | reference | feedback | pattern | observation | thread
  shape         TEXT NOT NULL,

  -- Axis 3 — WHO authored it. An enum, not the free-text column V1 used.
  -- authored | derived | extracted
  authorship    TEXT NOT NULL DEFAULT 'authored',

  scope         TEXT NOT NULL,

  -- User affordance: boost in ranking AND exempt from decay.
  pinned        INTEGER NOT NULL DEFAULT 0,

  -- Generic decay exemption. Deliberately NOT called `engagement`: the
  -- exemption mechanism is memory's and carries no personality semantics, while
  -- `engagement` names one particular reason a memory gets protected. Other
  -- modules become writers of this flag through a capability; none of them get
  -- a column of their own here.
  protected     INTEGER NOT NULL DEFAULT 0,

  -- The authoritative change signal. Not mtime — mtime-preserving edits exist.
  content_hash  TEXT NOT NULL DEFAULT '',

  -- Cross-machine lineage. Preserved verbatim when adopted from another machine.
  machine       TEXT NOT NULL DEFAULT '',

  -- Two genuinely different clocks. V1 called these updatedAt/syncedAt, which
  -- gave no clue which was which; recall ranks recency on the first and the UI
  -- lays out time on the second.
  authored_at   INTEGER NOT NULL,   -- when the human/agent wrote it
  ingested_at   INTEGER NOT NULL,   -- when we indexed it

  -- The entire input to contradiction detection.
  outcome       TEXT NOT NULL DEFAULT '',
  outcome_text  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_memories_scope  ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_shape  ON memories(shape);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);

-- ─────────────────────────────────────────────────────────────────────────────
-- Hubs: nodes that exist only so edges have somewhere to land.
-- No authored content, never decay, never a search result.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hubs (
  id    TEXT PRIMARY KEY,
  kind  TEXT NOT NULL,          -- file | tool | session | agent
  name  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hubs_kind ON hubs(kind);

-- ─────────────────────────────────────────────────────────────────────────────
-- Edges, split by LIFETIME. The table a relation lives in tells you who owns it
-- and what happens on re-ingest — no carve-out list required.
-- ─────────────────────────────────────────────────────────────────────────────

-- DECLARED: stated in the source's own frontmatter. Owned by `src`. Wiped and
-- rebuilt whenever src is re-ingested — which is safe precisely because nothing
-- else writes here.
CREATE TABLE IF NOT EXISTS declared_edges (
  src    TEXT NOT NULL,
  dst    TEXT NOT NULL,
  rel    TEXT NOT NULL,          -- mentions_file | mentions_tool | resolves | contradicts | occurred_in | evolved_into | authored_by | groups
  label  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (src, dst, rel)
);

-- OBSERVED: recorded by the system as things happen. MUST survive re-ingest —
-- losing these resets usage and decay signals, which is invisible in testing and
-- permanent in production. TWO independent reasons now rather than one:
-- `surfaced_in` is also IDENTITY EVIDENCE — rung 0 of the reconcile ladder
-- corroborates a declared id by asking whether that node was surfaced to the
-- writing session. A rule with two reasons survives a refactor that a rule with
-- one does not.
--
-- `concurrent_with` marks a slug collision — two writes claimed one slug for
-- unrelated facts, or two machines wrote concurrently. It lives here by the
-- lifetime rule, and because it accumulates settlement state. It is
-- DURABLE-BY-POLICY, not underivable: journal replay carries machine,
-- authored_at and slug, so it CAN be recomputed. We simply never discard it.
--
-- `also_ingested_in` records that a folded duplicate arrived under a different
-- scope. Without it a global content-hash fold silently narrows relevance — the
-- same fact saved in two projects keeps only the first scope, and under
-- scope-as-prior it ranks down in the second forever, with nothing anywhere
-- recording that it was ever relevant there.
CREATE TABLE IF NOT EXISTS observed_edges (
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  rel        TEXT NOT NULL,      -- surfaced_in | edited_in | concurrent_with | also_ingested_in
  count      INTEGER NOT NULL DEFAULT 1,
  first_at   INTEGER NOT NULL,
  last_at    INTEGER NOT NULL,
  PRIMARY KEY (src, dst, rel)
);

-- DERIVED: computed by a pass. Recomputed, never rebuilt from a source. The
-- score is a real number here rather than a `weight` column meaning three
-- different things depending on the relation.
CREATE TABLE IF NOT EXISTS derived_edges (
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  rel        TEXT NOT NULL,      -- similar_to
  score      REAL NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (src, dst, rel)
);

CREATE INDEX IF NOT EXISTS idx_declared_src ON declared_edges(src);
CREATE INDEX IF NOT EXISTS idx_declared_dst ON declared_edges(dst);
CREATE INDEX IF NOT EXISTS idx_observed_src ON observed_edges(src);
CREATE INDEX IF NOT EXISTS idx_observed_dst ON observed_edges(dst);
CREATE INDEX IF NOT EXISTS idx_derived_src  ON derived_edges(src);

-- ─────────────────────────────────────────────────────────────────────────────
-- Consume ledger. ONE mechanism, not V1's three stacked layers (stat cache
-- patched by a hash column patched by a ctime column).
--
-- KEYED BY THE TEXT, NOT BY THE MAILBOX IT ARRIVED IN. This replaced an
-- `ingest_manifest` keyed by `source`, which answered "have I seen this file in
-- this state" — the wrong question once the file is an inbox that empties. The
-- question ingest actually asks is "have I already consumed this exact text",
-- and a path key cannot express it.
--
-- WHAT THIS BUYS, AND ONLY THIS: re-running ingest is safe. Every step of the
-- consume protocol becomes replayable without producing duplicates.
--
-- WHAT IT DOES NOT BUY: it does not blunt the re-save problem. A session
-- re-saving from compacted context REGENERATES prose; it does not replay bytes,
-- so it never reaches this table at all. `seen_count` therefore measures
-- RETRIES, not re-saves — a plumbing signal, not evidence about deduplication.
--
-- Derived state, rebuilt by journal replay, so its hash normalization (strip
-- frontmatter, normalize whitespace) may change freely and costs only a
-- re-derive. That is why no canonicalization is frozen into the journal format,
-- which stores a plain hash over content it already holds.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consume_ledger (
  content_hash  TEXT PRIMARY KEY,
  memory_id     TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  seen_count    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_consume_memory ON consume_ledger(memory_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Quarantine: ingest declined this text because it looked like it carried a
-- credential.
--
-- IT HOLDS NO CONTENT, AND THAT IS THE WHOLE DESIGN. The obvious shape is a
-- holding pen that stores the text until a human reviews it — which would
-- create a NEW place secrets live, inside a database that gets interval
-- backups, for a feature whose entire purpose is to stop secrets spreading.
--
-- It does not need to. The consume protocol simply does not run for a declined
-- memory, so the ORIGINAL stays in the scratchpad `.md` where the writer put
-- it. Nothing is lost and nothing is copied: this table records that we
-- DECLINED, not what we declined.
--
-- Local by construction — the journal is what replicates, and a quarantined
-- memory never reaches it.
-- ─────────────────────────────────────────────────────────────────────────────
-- KEYED BY CONTENT HASH, not by mailbox: the scratchpad is re-scanned every
-- sync cycle and unchanged content must not grow this table on each pass. It
-- also makes the storage-layer refusal below expressible — a consumption for a
-- hash with an open decline is a bug, and it must fail loudly rather than
-- quietly removing the only copy.
CREATE TABLE IF NOT EXISTS quarantine (
  content_hash TEXT PRIMARY KEY,
  source       TEXT NOT NULL,    -- the scratchpad still holding the original
  findings     TEXT NOT NULL,    -- JSON: kind/line/hint only, NEVER the value
  seen_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quarantine_source ON quarantine(source);

-- A human's override of a false positive. Per-hash, so releasing one memory
-- never blanket-disables the scanner — and release pushes the content through
-- the ORDINARY ingest flow rather than a bypass, or released memories become
-- the one class that never got reconciled.
CREATE TABLE IF NOT EXISTS quarantine_released (
  content_hash TEXT PRIMARY KEY,
  released_at  INTEGER NOT NULL,
  reason       TEXT NOT NULL DEFAULT ''   -- a human's words. Not the content.
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Boot reconciliation state.
--
-- The graph's half of the redaction epoch. The manifest holds the other half,
-- and every boot compares them and replays the difference — so a restore that
-- skipped its procedure converges anyway. Enforcement at boot rather than at
-- restore, because restore is a human copying files and cannot be trusted to
-- follow a documented step.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Identity aliases. When a settleable pair is settled as one memory, two graph
-- ids become one — and every receipt and every id-declaring write pointing at
-- the loser must still resolve.
--
-- Without this, receipts dangle and, worse, an id-declaring write against the
-- losing id RESURRECTS the node that was settled away. Rung 0 consults this
-- table before anything else, so a settled id resolves forward.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS id_aliases (
  alias_id      TEXT PRIMARY KEY,
  canonical_id  TEXT NOT NULL,
  settled_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alias_canonical ON id_aliases(canonical_id);

-- ── rules ──────────────────────────────────────────────────────────────────
-- The rule fields of memories of kind `rule` (server/rules.ts), parsed at
-- ingest so rules.md and the checks need no re-parse. One row per rule memory;
-- it goes with the memory.
CREATE TABLE IF NOT EXISTS rules (
  id     TEXT PRIMARY KEY,
  fields TEXT NOT NULL
);

-- ── consolidation ─────────────────────────────────────────────────────────
-- Each background consolidation run, and every graph change it made, so a run
-- can be reverted whole by its id (private mind design 4.8). Memory text is
-- never rewritten by a run; it only adds hubs and derived edges.
CREATE TABLE IF NOT EXISTS consolidation_runs (
  run      TEXT PRIMARY KEY,
  at       INTEGER NOT NULL,
  stage    TEXT NOT NULL,
  model    TEXT NOT NULL,
  effort   TEXT,
  batches  INTEGER NOT NULL DEFAULT 0,
  ops      INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  status   TEXT NOT NULL,              -- running | done | partial | failed | reverted
  note     TEXT
);
CREATE TABLE IF NOT EXISTS consolidation_ops (
  run  TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- hub | edge
  a    TEXT NOT NULL,                  -- hub id, or edge src
  b    TEXT NOT NULL DEFAULT '',       -- edge dst
  rel  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run, kind, a, b, rel)
);
CREATE INDEX IF NOT EXISTS idx_derived_dst ON derived_edges(dst);

-- Pairs a relations pass has judged, so the same pair is not asked again.
CREATE TABLE IF NOT EXISTS relation_checks (
  a TEXT NOT NULL, b TEXT NOT NULL, relation TEXT NOT NULL, run TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
-- Staleness flags (design 4.8, D13): a reason to refresh or review, never to delete.
CREATE TABLE IF NOT EXISTS staleness (
  memory TEXT NOT NULL, reason TEXT NOT NULL, since INTEGER NOT NULL, detail TEXT, run TEXT,
  PRIMARY KEY (memory, reason)
);

-- People and titles that memories state (server/entities.ts), so a query naming a
-- role by department resolves to who holds it, and to the memories that say so.
CREATE TABLE IF NOT EXISTS people (
  memory_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  title     TEXT NOT NULL,
  roles     TEXT NOT NULL,          -- space-separated role keys: cmo, dept:cmo
  PRIMARY KEY (memory_id, name, title)
);
CREATE INDEX IF NOT EXISTS idx_people_memory ON people(memory_id);

-- Which memories the subject tables reflect, at which content and extractor version.
-- A memory whose hash or version differs is re-read; one that is gone is pruned.
CREATE TABLE IF NOT EXISTS subject_index (
  memory_id    TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  version      INTEGER NOT NULL
);

-- Constraint statements in memories (server/constraints.ts) and the subjects they are
-- about: `p:` names, `b:` phrases, space-separated. Rebuilt with the people table.
CREATE TABLE IF NOT EXISTS constraint_lines (
  memory_id TEXT NOT NULL,
  ord       INTEGER NOT NULL,
  text      TEXT NOT NULL,
  keys      TEXT NOT NULL,
  PRIMARY KEY (memory_id, ord)
);
