# What changes moving from V1 to V2

Every user-facing V1 feature, and what takes its place in V2. **Gone** means V2 has no code that does it. Read this before you migrate ([migration guide](migrating-from-v1.md)).

## What you will notice first

- **Memory files become stubs.** Once V2 has taken a memory file in, the file holds one line (`<!-- cortex:stub -->`) and the full text lives in V2's journal. Read memories with `/cortex-memory recall` and `show`, not by opening files.
- **No server and no web UI.** V1's dashboard (memory graph, code graph, sessions, machines, profile, the config editors and the terminal) has no replacement. Hooks run in-process. The only long-running processes are the mesh daemon (once you connect) and the host for host-only modules.
- **Comms is local-only until you connect.** Sessions on one machine talk through a local log. Nothing crosses machines until `cortex-mesh listen on` or `cortex-mesh peers add`.
- **Messages go to roles, not sessions.** A session joins a role (`cortex-role join`) to receive messages, and work messages carry claims, so two members never act on the same one.
- **The private mind syncs through a central node, not a git remote.** It carries journal records over the mesh, is off until enabled, and keeps working detail (threads, workflows) on the machine that wrote it, sending only a pointer.
- **No session-end extraction through the Anthropic API.** V2 never needs an API key. Optional nightly consolidation uses headless `claude -p` on your subscription, and is off by default.
- **Hooks can push back.** A standing rule with `enforce: deny` refuses a tool call; only a person at a terminal can lift it (`cortex-rules allow`). The Stop hook can send a turn back once: when a stated lesson was not recorded, when the reply asks you a fact memory holds, or when outgoing text breaks a deny rule.
- **The status line bus dot means something new.** Green means the session is a member of a role with a live watcher. V1's dots are no longer recognised. The status line needs `jq`.

## CLI scripts

| V1 | V2 | Status |
|---|---|---|
| `ckn-sync` | `cortex-memory sweep`; also automatic at session start and end, and right after a memory file is written | replaced |
| `ckn-mind-sync` | `cortex-mind status`, `dry-run`, `sync`, `remove`, `explain` (needs the mesh and a `mind.json`) | replaced, different transport |
| `ckn-sync-shared` (team shared mind) | none. The `gateway` module carries messages between organisations, not memory | **gone** |
| `ckn-bus` | `cortex-role` (`who`, `whoami`, `inbox`, `send`, `reply`, `watch`, `claim`, `check`, `done`) | replaced |
| `ckn-mesh` | `cortex-mesh` (`status`, `listen`, `peers add`, `config alias`) | replaced |
| `ckn-name-session` | `cortex-rename <name> [role]` | replaced |
| `ckn-threads` | none as a command. Thread memories are shown at session start and restored after a compaction. Use `cortex-memory recall <topic>` | partial |
| `ckn-context` | memory's session-start context and post-compaction restore | partial: no capability sheet |
| `ckn-pause-context` | comms prompt delivery and watcher reminder, memory prompt recall | partial: no snapshot reminder, no trust attributes |
| `ckn-aware` | rules triggered by tool, path or keywords (`kind: rule` with `when:`), secret and duplicate checks on memory writes | partial: no code-graph injection |
| `ckn-recall` (patterns on tool error) | consolidation's `lessons` stage turns repeated failures into lessons, offline | partial |
| `ckn-extract` | transcript capture (`cortex-memory capture`, `context search`) and consolidation | partial: dialogue is searchable verbatim instead of extracted |
| `ckn-precompact` | transcript capture at every Stop; existing V1 checkpoints are kept but stay out of recall | partial |
| `ckn-decay` | `cortex-memory protect`, `stale`; decay is part of ranking | partial: no fading list or archive |
| `ckn-derive` | `cortex-memory consolidate` (facets, relations, vocabulary; revertible per run) | replaced, different method |
| `ckn-embed-backfill` | none | **gone** |
| `ckn-acted-on` | usage grading is internal; `cortex-memory recall` shows the usage signal per hit | partial |
| `ckn-codegraph`, `ckn-codegraph-ingest`, `ckn-blast`, `ckn-graph-diff` | none | **gone** |
| `ckn-engagement` (CLAUDE.md block) | standing rules (`kind: rule`), rendered into `rules.md` and imported by CLAUDE.md. V2 leaves V1's block in CLAUDE.md; the purge checklist turns its lines into rules and removes it | replaced, different format |
| `ckn-observe-facets` (personal profile) | none. `cortex-memory facets` lists work topics, not a profile | **gone** |
| `ckn-stamp-lineage` | the journal stamps every record with the machine id; V2 keeps V1's machine id | replaced |
| `ckn-statusline` | `/cortex-statusline` | replaced |
| `ckn-install-config`, `ckn-install-worker` | `cortex-install` (per user), with one systemd unit per daemon or timer | replaced |
| `ckn-install-aliases` | `cortex-mesh aliases install` (`cortex`, `cortex-off`) | partial: fewer aliases |
| `ckn-update` | `/cortex-update` (`check`, `skip`, `mode off/ask/auto`); sessions are offered updates | replaced |
| `ckn-reboot` | not needed: there is no shared server | **gone** |
| `ckn-uninstall` | `cortex-install uninstall` | replaced |
| `ckn-backfill-md` | `cortex-memory reindex`, `restub`, `verify --repair` | replaced |
| `ckn-seed-onboarding`, `ckn-migrate-session-md`, `ckn-vite-guard` | none | **gone** (not needed) |

## Slash commands and skills

| V1 | V2 | Status |
|---|---|---|
| `/cortex-snapshot` | write a memory file as usual: it is taken in at once. The Stop hook makes sure a stated lesson gets recorded | partial |
| `/cortex-sync` | `/cortex-memory sweep`; private mind syncs by itself (CLI: `cortex-mind sync`) | replaced |
| `/cortex-sync-shared` | none | **gone** |
| `/cortex-rename` | `/cortex-rename <name> [role]` | replaced |
| `/cortex-bus`, `/cortex-available` | `/cortex-role` (join a role; `claim`, `done`) | replaced |
| `/cortex-threads`, `/cortex-continue`, `/cortex-handoff` | none. Send work to a role; the receiver claims it | **gone** |
| `/cortex-blast`, `/cortex-codegraph-diff`, the `codegraph` skill | none. The skill calls V1's server and cannot work without it: the purge removes it | **gone** |
| `/cortex-profile-setup` | none. Use `/cortex-rules` to write rules | **gone** |
| | New in V2: `/cortex-memory`, `/cortex-rules`, `/cortex-role`, `/cortex-mesh`, `/cortex-status`, `/cortex-statusline`, `/cortex-update`, `/cortex-telegram`, `/cortex-gate` | new |

## Memory files

V2 reads V1 memory files as they are: every `.md` under `~/.claude/memory/` and under `memory/` folders in `~/.claude/projects/` (`MEMORY.md` excepted). It reads `name`, `description`, `type` (also nested under `metadata:`), `node_type`, `kind: precompact-checkpoint` and `authorship: auto-extracted`.

These V1 keys are **kept as text but no longer acted on**:

| V1 key | What to do |
|---|---|
| `pinned: true` | Re-mark the memory `standing: true`, or run `cortex-memory standing <id> on`, to load it in every session |
| `engagement` | Re-write those preferences as standing rules (`/cortex-rules`) |
| `mentions_files`, `mentions_tools` | Use a rule with a `when: path:` or `when: tool:` trigger to put a note in front of a file or tool |
| thread state (`status`, `next_step`, `session_id`, `repo`, `branch`) | Kept in the text; there are no thread claims |
| `links`, `evolved_from`, `contradicts`, `resolves`, `outcome` | Consolidation derives relations instead |
| `machine` | The journal records the machine itself |

**Not imported:** V1's graph database (old bus messages, sessions, code graph), its embeddings, imported Obsidian notes that exist only in the database, and the private-mind and shared-mind git clones. Only memory files are taken in. The migration guide (step 8) shows how to bring in memories from a V1 machine that no longer exists.

## Other areas

| V1 | V2 | Status |
|---|---|---|
| Local embeddings for recall | none wired. Recall uses lexical seeds, graph expansion, usage, recency and pins | **gone** |
| Obsidian vault import | none (V1 never exported to Obsidian) | **gone** |
| Profile federation, capability sheet at session start, agent identity YAML | none | **gone** |
| Bus pagination, trust attributes on messages | none: use `--body-file` and `--file` attachments; peer messages are always treated as untrusted data | **gone** |
| Federated mesh | mesh daemon: one link per pair, routing across hops, file transfer through a secret scan, private addresses only | replaced |
| | Secret gate and quarantine on memory; `cortex-backup`; `cortex-schedule`; `cortex-status`; the `gateway` and `telegram` modules | new |
| MCP server | none in either version | unchanged |
