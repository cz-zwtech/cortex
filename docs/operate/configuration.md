---
name: cortex-configuration
description: "Every CKN_* environment variable and config file Cortex reads"
audience: operator
---

# Configuration via environment variables

Cortex reads these env vars at process start:

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | **Optional.** Enables Path A — automatic SessionEnd LLM extraction via the Anthropic SDK. Without it, use Path B: type `/cortex-snapshot` before exiting your session. Can be sourced from a secret manager via `CKN_API_KEY_CMD` (below) so it never lives in a file. See "Memory extraction — two paths" above. |
| `CKN_API_KEY_CMD` | unset | **Optional, advanced.** A command whose stdout is the Anthropic API key, used by the Anthropic-calling hooks (`ckn-extract` at SessionEnd, `ckn-name-session`) when `ANTHROPIC_API_KEY` is not already in env — e.g. for OpenBao: `secret-run ANTHROPIC_API_KEY -- printenv ANTHROPIC_API_KEY`. The key is fetched transiently at extraction time and never written to a file or surfaced. **Graceful by design:** if the command fails, times out, or the key isn't present (e.g. `secret-run` exits non-zero), extraction resolves to "no key" and no-ops exactly as if the env var were unset — never an error. Because a secret manager's path is dynamic/user-specific, this is opt-in (you set it at setup), never assumed. |
| `CKN_BIND` | `127.0.0.1` | Bind address for both Express (3001) and Vite (1420). Set to `0.0.0.0` for worker-mode LAN exposure. |
| `CKN_PORT` | `3001` | Express port. |
| `CKN_FORCE_SERVER` | unset | When `1`, hooks fail loudly (or silently skip in PreCompact) instead of falling back to direct DB access. **Required for worker mode** — routes all writes through the single-writer server rather than opening the SQLite file directly. |
| `CKN_EMBEDDINGS` | `local` | `local` (bge-small via @huggingface/transformers, in a worker thread), `remote` (reserved, not implemented), or `off` (substring search only). See "Embeddings". |
| `CKN_CODEGRAPH_CORE_BRANCHES` | `main,master,develop,release/*,feature/*,integration/*` | Comma-separated glob list of **core** branches for the code-graph sync-on-completion policy (`classifyBranch`). `ckn-codegraph --on-complete` re-ingests only on a core branch; everything else (`epic/*`, `wip/*`, ad-hoc) is **ephemeral** and no-ops (unless `--force`). On-query freshness (`ckn-blast`) ignores this — it refreshes any branch. `*` matches within a path segment, `**` crosses `/`. See "Code graph → Sync on completion". |
| `CKN_EMBED_MAX_QUEUE` | `6` | Max in-flight embedding requests before new ones shed (return null → caller degrades to substring/graph recall). Bounds the embedding worker's backlog. |
| `CKN_PRIVATE_MIND` | unset | Set to `off` to hard-disable the cross-machine private-mind sync even if a clone+remote are configured. See "Private-mind". |
| `CKN_PRIVATE_MIND_PATH` | `~/.config/ckn/private-mind` | Where the private-mind git clone lives. Override to keep it in your projects workspace (e.g. `~/projects/private-cortex`). The per-machine sync baseline stays at `~/.config/ckn/private-mind.state.json` regardless. |
| `CKN_MIND_PUSH_ON_BOOT` | unset | When `1`, the startup private-mind sync **pushes** local commits to the federation (in addition to pulling). Default (unset) is **pull-only on boot** — a restart adopts remote changes but never silently publishes local ones. Explicit `ckn-mind-sync` / `/api/mind/sync` always push regardless. |
| `CKN_MESH_PEERS` | unset | Comma-separated `http://host:port` of the other Cortex nodes for the cross-machine **mesh tier**. Bare `host:port` is normalized to `http://`. v1 assumes a full mesh (each node lists the others). With a token present (below), the mesh tier composes a `MeshBroker` into the bus. See "Cross-machine: the mesh tier". |
| `CKN_MESH_TOKEN` | unset | The single fleet token gating `/api/mesh/*` (the HMAC key for per-request mesh auth — it is never transmitted). A **plain secret**: provide it however you manage secrets — a plain `export CKN_MESH_TOKEN=…` on a single trusted workstation, or launcher-fetched (`secret-run CKN_MESH_TOKEN -- …`, e.g. via OpenBao) for a fleet so it's never baked into a file or logged. Same value on every node. **Fail-closed:** `CKN_MESH_PEERS` set but this missing ⇒ the mesh tier refuses to activate. |
| `CKN_MESH_GOSSIP_MS` | `20000` | Presence-gossip interval (ms) for the mesh loop: bidirectional presence exchange + reachability tracking + catch-up trigger on peer recovery. |
| `CKN_MESH_ZOMBIE_MS` | `600000` | A reachable peer reporting zero sessions and silent past this window (ms) is evicted from the active fleet view + broadcast targets (a new session on it revives it instantly). |
| `CKN_PROFILE` | unset (off) | **Surfacing switch for the personality profile — opt-in, default OFF.** Facets are **always tracked** in the background regardless; this gates only whether the profile is *surfaced*. Set to `1` (or `on`/`true`) to inject your profile perception at session start, allow the cold-start `/cortex-profile-setup` nudge, and show the dashboard **Profile** view. Unset/off ⇒ no profile section in the capability sheet, no injection, no onboarding prompt, Profile view hidden — fully silent, but the profile keeps building so it's ready when you enable. Set it where the hooks see it (the `env` block of `~/.claude/settings.json`, or your shell / systemd unit). |
| `CKN_DERIVE_ON_STOP` | unset | Set to `1` to auto-refresh observations after each Stop-hook sync. Off by default (keeps Stop-hook latency predictable). |
| `CKN_AUTO_SNAPSHOT` | unset | Set to `off` to disable the periodic /cortex-snapshot prompt (Path B safety net). Fires at UserPromptSubmit (a turn boundary), not mid-tool-chain. |
| `CKN_SNAPSHOT_AT` | `25` | Turns between auto-snapshot prompts. Set to `0` to disable. |
| `CKN_SNAPSHOT_MIN_INTERVAL` | `600` | Minimum seconds between auto-snapshot fires. Prevents bursty sessions from triggering multiple snapshots in quick succession. |
| `CKN_AGENT_ID` | unset | Stable agent UUID. When set, extraction tags memories with `authorship: agent` automatically. |
| `CKN_AUTHORSHIP` | `auto-extracted` | Override authorship explicitly: `human`, `agent`, `mixed`, `auto-extracted`. |
| `CKN_LINEAR_TICKET` | unset | Written to memory frontmatter when set. |
| `CKN_TASK_BRANCH` | unset | Git branch the agent is working in — written to memory frontmatter. |


## Configuration

| Setting | Path | Notes |
|---|---|---|
| App settings | `~/.config/ckn/config.json` | Anthropic API key (reserved), shared-mind config |
| UI state | `~/.config/ckn/ui-state.json` | Project tags, hidden tags, hidden sessions, last selections |
| Memory store (graph) | `~/.config/ckn/graph.sqlite` | SQLite (better-sqlite3), holding the graph-structured memory. Safe to delete — rebuilds from memory files on next sync |
| Server log | `~/.local/state/ckn/server.log` | When started via the helper aliases |

In the Cortex UI, **Settings dialog** (gear icon) lets you set the shared-mind remote URL and a few preferences. **Shared Mind dialog** (up/down arrow icon) drives the publish queue + sync.


Related: [[cortex-running]] · [[cortex-secrets]] · [[cortex-embeddings]]
