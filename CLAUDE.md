# Cortex

A browser-served app + headless hook system that gives Claude Code a persistent
graph memory, session monitoring, and a publish/subscribe shared mind across
machines and users.

## Commands

```bash
npm start            # server (3001) + vite (1420)
npm run server       # backend only — Express + WS + SQLite graph
npm run dev          # frontend only
npm run sync         # one-shot memory sync into the graph
npx tsc --noEmit     # type-check
```

The daemon-style server is optional — hooks under `bin/` work standalone via a
direct path that talks to the SQLite graph DB without an HTTP round-trip. The UI
is for human monitoring + manual control; Claude operates against the graph
through hooks regardless of whether the UI is running.

## Helping a user set up Cortex

When a user asks you to install or configure Cortex, figure out **which path**
they want before running commands — they're not mutually exclusive, but each has
a distinct entry point. The full prose lives in `README.md`; this is the decision
guide. Never bake secrets into files or chat (API keys, remotes with embedded
tokens) — use env vars / SSH remotes.

1. **Fresh local install** (their workstation/dev box). Clone → `npm install` →
   `npm start`. First boot auto-registers the hooks, slash commands, and skills
   into `~/.claude/` — including the `codegraph` skill (the AST code-graph tier
   ships in-box; no separate clone). Then `npm run install-aliases` for
   `ckn-start/stop/log/status` plus `ckn-codegraph <path>` (build a repo's AST
   graph; also `/codegraph add <path>` from a session).
   Verify: `curl -s localhost:3001/api/graph/stats`, UI at `localhost:1420`.
   Prereqs: Node 20+, a C/C++ toolchain + Python 3 (native dep `node-pty`),
   git. See README "Prerequisites" / "Manual install".

2. **Connect a NEW machine to their private mind** (e.g. a laptop). Install first
   (path 1), then **once**: `ckn-mind-sync --remote <their-private-cortex-url>`.
   That clones the private repo and adopts their whole mind (memories re-index
   into this machine's graph; the codegraph/AST tier replays too), then pushes
   anything local. KEY behavior to tell them: **the boot sync is pull-only by
   default** — a restart adopts remote changes but does NOT auto-push. To publish
   from this machine they run `ckn-mind-sync` explicitly, or set
   `CKN_MIND_PUSH_ON_BOOT=1`. `ckn-mind-sync --status` shows state. Private-mind
   is THEIR whole mind across THEIR machines — distinct from shared-mind.

3. **Subscribe to a shared (team) mind.** Set the remote (Shared Mind dialog, or
   `POST /api/shared/remote {url}`), then `/sync-shared` in any session. Pulled
   memories land in scope `shared:<name>`, quarantined. This is selective/public/
   team-facing — not the same as private-mind.

4. **Headless worker / server box.** `npx tsx bin/ckn-install-worker.ts --remote
   <shared-url>` generates a systemd user unit, enables linger, starts the
   service. Embeddings can stay ON here — inference runs in a worker thread, so
   multi-session load no longer wedges the event loop.

5. **Memory-extraction auth — two paths (ask which they have).** Path A: set
   `ANTHROPIC_API_KEY` → automatic LLM extraction at SessionEnd (billed via the
   Anthropic console, ~$0.005/session). Path B: no key → they run `/snapshot`
   (uses their claude.ai subscription); a periodic prompt reminds them. Same
   output either way.

6. **Embeddings mode.** Default `local` (bge-small in a worker thread — safe under
   load). `off` for tiny/air-gapped boxes. `remote` is a stub. Set via
   `CKN_EMBEDDINGS`; takes effect on restart.

7. **Per-user parity on a shared / interactive host.** First boot registers config
   only for the user the server runs as. On a box where *another* user also has
   interactive Claude Code sessions, give them full parity in one command — run
   **as that user**, from the canonical install dir:
   `npm run install-config` (or `tsx bin/ckn-install-config.ts`). It merges the 8
   hooks + all slash commands + skills into that user's `~/.claude` (preserving their
   theme / statusLine / other settings), points every hook at this install (their
   session shares the install; no per-user clone), writes their `~/.config/ckn/home`,
   sets `CKN_FORCE_SERVER=1` + `CKN_BIND=0.0.0.0`, and installs shell aliases.
   Idempotent — re-running is a no-op. `--home <dir>` / `--user <name>` target another
   home (naturally gated by filesystem perms; run-as-self needs no extra privilege).

Env vars that gate the above (full table in README): `CKN_PROFILE`
(personality surfacing opt-in, default off), `ANTHROPIC_API_KEY`,
`CKN_EMBEDDINGS`, `CKN_PRIVATE_MIND` / `CKN_PRIVATE_MIND_PATH` /
`CKN_MIND_PUSH_ON_BOOT`, `CKN_BIND` / `CKN_PORT` / `CKN_FORCE_SERVER` (worker mode).

## Architecture

| Layer | Path | Role |
|---|---|---|
| Ontology | `src/ontology/` | Zod schemas + types for every config kind |
| Adapters | `src/adapters/` | FS read/write per kind, REST clients |
| Registry | `src/registry/` | Project list, UI state, settings, caches |
| Engine | `src/engine/` | Reference graph, scope hierarchy, validation |
| UI Primitives | `src/ui-primitives/` | Generic field components, dialogs, markdown |
| UI Descriptors | `src/ui-descriptors/` | Per-kind mapping of fields → primitives |
| App Shell | `src/app/` | Zustand store, view router, chrome |
| Server | `server/` | Express, chokidar watcher, WS, SQLite graph, hook scripts |
| Hooks | `bin/` | tsx-callable scripts that hook into Claude Code lifecycle |

## Adding a New Config Kind

1. `src/ontology/{kind}.ts` — Zod schema + type
2. `src/ontology/index.ts` — `KindSpec`, register in `kindSpecs` and `allKinds`
3. `src/ontology/core.ts` — add to `Kind` enum
4. `src/adapters/{kind}Adapter.ts` — `read*`, `write*`, `delete*`
5. `src/adapters/index.ts` — wire into `readAll`, `readByKind`, `writeEntity`, `createEntity`, `deleteEntity`
6. `src/ui-descriptors/{kind}.tsx` — `UiDescriptor<T>` with `Editor` component
7. `src/ui-descriptors/index.ts` — add to `descriptors` record
8. `src/app/store.ts` — add bucket to `EntitiesByKind` and `emptyBuckets()`

Read-only kinds (e.g. `conversation`): set `readOnly: true` on `KindSpec`. The
shell and palette automatically hide create/edit/delete for these.

## Key Patterns

**Entity identity** — Every `Entity<T>` carries `origin: T` (the value at load
time). Adapters must use `entity.origin` (not `entity.value`) to locate the
artifact on disk during rename/delete. This prevents identity bugs when users
edit fields like `name` before saving.

**Live editing** — `updateEntity` in the store debounces writes at 350ms. No
save button.

**Scope** — Two scope types: `user` (global `~/.claude/`) and `project`
(`{project}/.claude/`). `KindSpec.validScopes` controls which sidebar sections
show a kind. Graph entries also use synthetic scopes: `vault:<name>` for
imported vaults, `pattern:auto` for fail→success patterns, `shared:<name>` for
imported shared-mind memories.

**Claude's project encoding** — `~/.claude/projects/` uses
`path.replace(/[\/\\:]/g, '-')` as directory names. Used by memory and
conversation adapters.

**File watching** — `server/watcher.ts` (chokidar) emits `fs:change` events
over WS; the store debounces reloads at 250ms. Same watcher emits
`session:append` and `session:state` for live JSONL transcripts.

**Hooks have a dual path** — every script under `bin/` first tries the local
API (`http://localhost:3001`) and falls back to direct module import + SQLite
access if the server isn't responding. This keeps the system functional when
the UI isn't running.

**The server owns the graph file** — better-sqlite3 statements are synchronous
and single-process; the server (port 3001) owns the `graph.sqlite` file. Every
CLI graph opener must be API-first and direct-open ONLY when no server is bound
(use `bin/_graph-guard.ts`: `isServerUp()` / `directFallbackMode()`). WAL mode
lets a CLI read concurrently, but writes still route through the server to keep
a single writer. See `/personal/docs/cortex-graph-write-concurrency.md`.

**Memory lineage** — every memory carries a `machine:` frontmatter field
(stamped by `ckn-extract`; mirrored to `Entry.machine`). Adopted memories keep
their origin machine verbatim across a private-mind sync. New memories written
by hand should include it; `bin/ckn-stamp-lineage.ts` backfills old ones.

**Session bus** — server-brokered, this-machine-only cross-session coordination (migration `0008`). `ckn-bus` is **API-only** (server must be up; exits non-zero if it isn't). Peer messages are surfaced as untrusted `<inter-session-message>` content — never auto-executed. Presence rides existing hooks: `ckn-context` registers on SessionStart, `ckn-pause-context` re-asserts presence (self-healing heartbeat) + delivers the inbox on UserPromptSubmit, `ckn-extract` signs off on SessionEnd. No daemon, no new hook registrations. **Self-heal:** `touchSession` (`POST /api/bus/touch`) is an upsert that revives a `signed_off`/resumed session and bumps `last_seen` on every prompt while preserving the friendly name — so a failed SessionStart registration or a `-c`/`--resume` heals by the next prompt. Internal subprocesses under `~/.claude-memory` are filtered out of the bus. CLI identity resolves via `--session` → `CLAUDE_CODE_SESSION_ID` env → cwd-transcript fallback. Friendly name = `/rename` title or short session-id prefix; durable across restarts (rebind). States: `live` (<5 min) / `idle` (5–60 min) / `stale` (>60 min) / `signed_off`. Use `/bus` or `ckn-bus peers|inbox|send|reply|ack|whoami|watch`.

## Data Sources

| What | Where |
|---|---|
| Project list | `~/.claude.json` — keys of the `projects` object |
| User configs | `~/.claude/` — agents, commands, skills, rules, hooks, settings.json |
| Project configs | `{project}/.claude/` — same structure |
| Memories | `~/.claude/projects/{encoded}/memory/*.md` |
| Conversations | `~/.claude/projects/{encoded}/*.jsonl` |
| Graph DB | `~/.config/ckn/graph.sqlite` (SQLite / better-sqlite3) |
| App settings | `~/.config/ckn/config.json` |
| UI state | `~/.config/ckn/ui-state.json` |
| Shared mind clone | `~/.config/ckn/shared-mind/` (selective, public, team-facing) |
| Private mind clone | `~/.config/ckn/private-mind/` (your whole mind across your machines; opt-in) |
| Private-mind local baseline | `~/.config/ckn/private-mind.state.json` (per-machine 3-way ancestor) |
| Machine identity | `~/.config/ckn/machine-id` (lineage stamp) |

## Tech Stack

- **React 19** + **Vite 6** + **Tailwind v4**
- **Express 4** — REST + WS server
- **better-sqlite3** — embedded SQLite graph DB
- **Zustand** — global store
- **Zod** — runtime schema validation for every config kind
- **CodeMirror 6** — markdown editing
- **D3** — force-directed graph view
- **Shiki** — syntax highlighting in markdown preview
- **react-markdown** + **remark-gfm** for callouts
- **sonner** — toasts
- **cmdk** — command palette
- **chokidar** — file watcher
