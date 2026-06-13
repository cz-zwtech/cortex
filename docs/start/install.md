---
name: cortex-install
description: "Install Cortex: paste-into-Claude auto-install, manual install, and what lands on your system"
audience: user
---

# Auto-install (paste into Claude Code)

Open a fresh Claude Code session **anywhere** (you don't need to be in this repo) and paste the block below. Claude will clone, install, and verify Cortex for you. Permissions need to allow `Bash(*)` and `Write(*)` for the duration.

```
You're going to install Cortex for me. Cortex is a graph-structured memory + hook system
for Claude Code that lives at https://github.com/cz-zwtech/cortex. Do this
carefully:

1. Clone the repo to ~/cortex (or another location if ~/cortex exists — pick a
   sensible path and use it consistently below):

     git clone git@github.com:cz-zwtech/cortex.git ~/cortex

   If SSH access fails, fall back to HTTPS:
     git clone https://github.com/cz-zwtech/cortex.git ~/cortex

2. cd ~/cortex && npm install. Wait for it to finish; it pulls a lot.

3. Start the server in the background once. This installs hooks + slash
   commands into ~/.claude/ on first boot:

     mkdir -p ~/.local/state/ckn
     cd ~/cortex && nohup npm start > ~/.local/state/ckn/server.log 2>&1 &
     sleep 10

4. Verify the install:

   - `tail -20 ~/.local/state/ckn/server.log` should show:
       [ckn] server ready on http://localhost:3001
       [ckn] registered 8 hooks in ~/.claude/settings.json: ...
       [ckn] installed 8 slash commands in ~/.claude/commands/: /cortex-sync-shared, /cortex-snapshot, /cortex-rename, /cortex-bus, /cortex-available, /cortex-blast, /cortex-codegraph-diff, /cortex-profile-setup
       [ckn] installed codegraph skill in ~/.claude/skills/

   - `ss -tlnp | grep 3001` should show the server listening.

   - `ls ~/.claude/commands/cortex-sync-shared.md` should exist.

5. Open the UI to verify visually:
     http://localhost:1420
   You should land on the home view with the neural-web visual.

6. Install shell helper aliases. This auto-detects $SHELL and writes
   ckn-start / ckn-stop / ckn-log / ckn-status / ckn-mind-sync plus the
   client CLIs ckn-bus / ckn-recall / ckn-sync into the right rc file
   inside an idempotent managed block:

     cd ~/cortex && npm run install-aliases

   Then either `source` the rc file or open a new shell.

7. Seed the bundled onboarding corpus into my local graph so YOU (Claude) can
   lean on Cortex's own recall for the rest of setup instead of re-reading this
   README. This is bundled in the repo — no team mind or remote required:

     curl -sX POST http://localhost:3001/api/graph/seed-onboarding
     # (equivalently: cd ~/cortex && npm run seed-onboarding -- --local)

   It writes ~16 memories under scope `shared:cortex` (overview, the setup
   paths, private-mind connect, embeddings modes, troubleshooting, …). After
   this, in a NEW Claude Code session the SessionStart hook surfaces them and
   you can answer my setup questions from recall.

8. Now let's set up the right "mind" for me — ASK me, don't assume:
   - **Do I have a private mind** (my own memory synced across my own machines,
     e.g. a `private-cortex` git repo)? If yes, get its URL from me and run
     `ckn-mind-sync --remote <url>` once — it clones + adopts my whole mind.
     (Boot sync is pull-only; that's intended.) If this is my first machine,
     skip — there's nothing to pull yet.
   - **Do I have a team shared mind** to subscribe to? Most users don't (it's
     optional). Only if I give you a URL: set it via
     `curl -sX POST -H "Content-Type: application/json" -d '{"url":"<url>"}' http://localhost:3001/api/shared/remote`
     then run `/cortex-sync-shared`. Pulled memories land quarantined under
     `shared:<name>`.
   - If I have neither, that's fine — Cortex is fully functional standalone.

9. Ask whether I want to join my fleet's mesh (OPTIONAL — local-only is fully
   functional). The mesh lets THIS machine's sessions see + coordinate with my
   OTHER machines: one shared session bus and cross-machine memory. If I want in,
   ASK me for ONE reachable peer URL (a server, or any inbound-reachable node):

     ckn-mesh set --peer http://<reachable-peer-host>:3001

   That seeds gossip from one peer; the node learns + persists the rest of the
   fleet to ~/.config/ckn/mesh-peers.json. Membership is reachability-driven —
   off-network it falls back to local-only and auto-rejoins later (no env flip).
   Prefer this over the static CKN_MESH_PEERS env (each node listing the others).
   Full detail + the no-server WSL↔WSL relay case: docs/install-wsl-driver-node.md.
   If I don't have another machine yet, skip this.

10. Tell me what landed: which hooks were installed, the server PID, the UI URL,
   how many onboarding memories seeded, whether a private/shared mind was wired
   up, and any warnings or errors from the log. If anything failed, report it
   plainly — do not silently retry destructive operations.

11. IMPORTANT — tell me to restart my Claude Code session now. First boot wrote
    the SessionStart hooks + slash commands into ~/.claude/settings.json, but
    THIS session started before they existed, so they are not loaded in it. The
    hooks (context injection, recall, bus presence) and the new slash commands
    (/cortex-snapshot, /cortex-sync-shared, /cortex-rename, /cortex-bus) only activate in a session started
    after the install. Once I restart, the SessionStart hook surfaces the seeded
    onboarding memories and you can drive the rest from recall.
```

That prompt installs Cortex end-to-end. The auto-installed hooks fire on every Claude Code session you run thereafter — across every project — without further intervention. The onboarding seed means your Claude can drive the rest of setup conversationally, leaning on Cortex recall rather than this document.

---

## What gets installed

**Eight hook registrations** (seven distinct scripts — `ckn-context` fires on both `SessionStart` and `PostCompact`) auto-register into `~/.claude/settings.json` on first server boot. Additive (don't clobber existing hooks), idempotent (markers gate re-registration):

| Hook | Event | Script | Purpose |
|---|---|---|---|
| `ckn-context` | `SessionStart` | `bin/ckn-context.ts` | Capability sheet (skills, MCP, permissions, sub-agents) + cwd-scoped recent memories. Also creates a `session-<sid>.md` placeholder so the session is queryable from turn 1. Also registers/refreshes the session's bus presence (session bus). |
| `ckn-aware` | `PreToolUse` | `bin/ckn-aware.ts` | Aware-cache hot-path; surfaces divergence memories or shared knowledge about the tool being invoked. Microsecond exit when nothing relevant. |
| `ckn-recall` | `PostToolUse` | `bin/ckn-recall.ts` | On tool **error** (anchored on the tool result's `isError`, so clean successes never trigger it), runs graph-augmented recall — vector seeds + typed-edge expansion + composite scoring — and injects matches. Also bumps the turn counter that gates the periodic `/cortex-snapshot` prompt. |
| `ckn-pause-context` | `UserPromptSubmit` | `bin/ckn-pause-context.ts` | Emits the periodic `/cortex-snapshot` reminder at a turn boundary (never mid-tool-chain). Gated by turn count + a minimum interval; tunable via `CKN_SNAPSHOT_AT` / `CKN_SNAPSHOT_MIN_INTERVAL` / `CKN_AUTO_SNAPSHOT=off`. Also delivers the bus inbox (session bus delivery floor). |
| `ckn-sync` | `Stop` | `bin/ckn-sync.ts` | Re-syncs all .md memory files into the graph, embeds new entries, materializes typed edges from frontmatter, replays recorded vault imports. |
| `ckn-precompact` | `PreCompact` | `bin/ckn-precompact.ts` | Captures last ~50 turns into a checkpoint memory before `/compact` strips context. |
| `ckn-context` | `PostCompact` | `bin/ckn-context.ts` | Re-injects capability sheet + memories so post-compact has the same recall as a fresh session. |
| `ckn-extract` | `SessionEnd` | `bin/ckn-extract.ts` | Verbatim-anchored LLM extraction (Haiku). Categorizes session events into typed memories (decisions, errors, workflows, references). Outcome text copied verbatim from JSONL — never paraphrased. Updates session entry with name/description/counts. Also signs the session off the bus (`signed_off` presence). |

**Slash commands** (auto-installed at `~/.claude/commands/`):

| Command | Purpose |
|---|---|
| `/cortex-sync-shared` | Pull from the cortex-mind shared remote, import memories, compute divergences. Runs without the UI open. |
| `/cortex-snapshot` | On-demand version of SessionEnd extraction — capture the current session's worth-remembering content into memory files mid-session without closing it. |
| `/cortex-rename [name]` | Name the current session via Claude Code's native `custom-title` event. With no argument, derives a topic-based name from the session (memory slugs → first prompt → git commit subjects → timestamp fallback). The name also becomes this session's bus friendly name. |
| `/cortex-bus` | Session bus shorthand — peers, inbox, send, and ack. Equivalent to invoking `ckn-bus` subcommands; server must be running. |
| `/cortex-profile-setup` | Guided setup that seeds how you want Claude to interact with you (the personality profile). Answers become soft *declared* facets that decay and are overtaken by observed behavior; re-run anytime. |
| `/cortex-available` | Opt this session into the orchestration pool — the explicit green-light that a coordinator session may assign it work. Presence alone never makes a session dispatch-eligible; solo sessions stay out of the pool. |
| `/cortex-blast` | Blast-radius query for a file/symbol — what's impacted if you change it (runs `ckn-blast`, auto-refreshing a stale graph). |
| `/cortex-codegraph-diff` | Predict competing changes between two branches before a text-level merge conflict (runs `ckn-graph-diff`). |

**A `codegraph` skill** is also installed at `~/.claude/skills/codegraph/` — build/refresh a repo's AST code graph (`/codegraph add <path>` or `ckn-codegraph <path>`) and query who-depends-on / blast-radius. The PreToolUse hook auto-injects a file's blast-radius before you edit it.

**MCP servers: nothing to install.** Cortex registers **no** MCP server of its own — there is no `mcp__cortex__*` toolset and no `mcpServers` entry written to `~/.claude.json`. MCP appears in Cortex only as (a) a *config kind* you can view/edit/promote in the UI (it inventories the MCP servers you already have) and (b) an optional *artifact* a shared mind can carry between teammates. A fresh install needs no MCP step.


## Manual install

If you'd rather do it by hand:

```bash
git clone git@github.com:cz-zwtech/cortex.git ~/cortex
cd ~/cortex
npm install
npm start  # server on :3001, UI on :1420
```

First boot writes:
- `~/.claude/settings.json` — hook registrations
- `~/.claude/commands/cortex-sync-shared.md` — slash command
- `~/.config/ckn/graph.sqlite` — SQLite database holding the graph-structured memory (better-sqlite3)
- `~/.config/ckn/shared-mind/` — git working clone for shared mind (created on first publish/sync)

Then open http://localhost:1420.

**Restart your Claude Code session after first boot** so the just-written SessionStart hooks + slash commands load — the session that ran the install started before they existed and won't have them until it's restarted.


## Next: join your fleet (optional)

A fresh install is fully functional standalone. To let this machine see and coordinate with your **other** machines — one shared session bus and cross-machine memory — join them into a mesh:

→ **[Add a machine to your fleet (mesh)](../install-wsl-driver-node.md)**

The canonical join is one command: seed gossip with a single reachable peer, and the node learns + persists the rest of the fleet.

```bash
ckn-mesh set --peer http://<reachable-peer-host>:3001
```

Membership is reachability-driven — off-network the node falls back to local-only and auto-rejoins when peers return (no env flip). `CKN_MESH_PEERS` is a static alternative (each node lists the others), but prefer `ckn-mesh set --peer` — gossip discovers the rest and survives fleet changes. The page above also covers the no-server case (WSL↔WSL relay).


Related: [[cortex-prerequisites]] · [[cortex-permissions-and-agents]] · [[cortex-running]] · [[cortex-secrets]]
