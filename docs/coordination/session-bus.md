---
name: cortex-session-bus
description: "Same-machine session presence and messaging: identity, delivery, the watcher"
audience: user
---

# Session bus (cross-session coordination)

Claude Code sessions on the same machine can communicate through the Cortex server — presence, addressing, and message delivery without a separate daemon or a hand-edited markdown file. The bus replaces the old `docs/communication/session-bus.md` protocol.

**What it is.** Each session registers a *presence* on startup and can be addressed by a durable *friendly name*, its raw session id, or `*` for broadcast. The broker is the Cortex server at `:3001`. Schema: migration `0008` (Session presence columns + BusMessage table, backed by the SQLite graph).

**Identity / whoami.** On `SessionStart`, `ckn-context` registers the session with a friendly name derived from: (1) the `/cortex-rename` custom-title if one is set, else (2) a short prefix of the session id. The name is durable: if the same session is resumed (new session id, same name + cwd), the new session *rebinds* the name and inherits any undelivered messages addressed to it. Rebind/name-inheritance applies to **named** sessions (those with a `/cortex-rename` title); an un-renamed session's friendly name is its short session-id prefix, which changes on restart, so it does not rebind. Broadcasts are scoped to a session's lifetime — a session receives only broadcasts sent at/after its registration (no replay of historical broadcasts).

**The three names a session has.** A session carries up to three distinct names; `/cortex-rename` sets the first of them.

1. **Session id (the UUID)** — `a182621d-…`, the `<uuid>.jsonl` filename. Immutable, non-human-friendly, machine-stable: every hook, the graph, and `--resume` key off it. It never changes and you never type it.
2. **Custom-title (the friendly terminal name)** — what `/cortex-rename <name>` sets: it appends a `custom-title` event to the session JSONL (`bin/ckn-name-session.ts`), the *same* native mechanism as `claude -n "<name>"`. Claude Code shows this in the terminal title/prompt label and the `--resume` picker, and propagates it across `--resume`/`-c`. It's *your* human label for finding the session again. `/cortex-rename` with no argument auto-derives a topic (memory slugs → first user prompt → git commit subjects → timestamp fallback). SessionStart re-reads the latest custom-title and surfaces it in the capability sheet so Claude knows the session's topic from turn 1. (Gotcha: Claude Code only reads the custom-title at session *start*, so a mid-session `/cortex-rename` won't update the terminal title bar until you `--resume`/`-c` — the JSONL is updated immediately regardless.)
3. **Graph memory name** — the `Session` node Cortex stores (backed by `session-<sid>.md`), named + described by SessionEnd extraction (Path A) from what the session was actually *about*. This is what the Knowledge/Graph views show, and it's Cortex's own summary — independent of your custom-title. With no API key (Path B), the node keeps its placeholder name until `/cortex-snapshot` fills it in.

So: the UUID identifies, the custom-title is how *you* find it, and the graph name is how *Cortex* describes it.

**Presence states.** Cortex tracks four states based on how recently a session was last seen: `live` (within 5 min), `idle` (5–60 min), `stale` (over 60 min, presumed dead). A session that shuts down cleanly is set to `signed_off` by the `SessionEnd` hook. No daemon required — presence rides the existing hook lifecycle.

**Self-healing presence.** Every user prompt re-asserts liveness: the `UserPromptSubmit` hook bumps `last_seen` *and revives* a `signed_off` session. This makes presence robust to the two ways SessionStart registration can be missed — the server being down/restarting at launch, and a `-c`/`--resume` of a previously signed-off session (which keeps the old id). A re-asserted session shows up `live` by its next prompt and **keeps its friendly name** — the heartbeat never clobbers a `/cortex-rename`d identity. Internal Cortex subprocesses (memory flush/cortex-snapshot/extract, which run Claude under `~/.claude-memory`) are excluded from the bus so the peer list stays limited to human-touched working sessions.

**Hybrid delivery.** Inbound messages reach you two ways:
- *Floor (always on):* The `UserPromptSubmit` hook (`ckn-pause-context`) surfaces any undelivered messages from your inbox at the next prompt boundary. You never miss a message — it catches up on the next prompt you send.
- *Real-time (per session):* A `ckn-bus watch` task armed via Claude Code's **Monitor tool** delivers in ~1 second. A Monitor task can only be started by the model (a tool call) — no hook can launch it, and a shell `&` job won't do (its stdout never reaches the model's context). So Cortex makes the model arm it reliably with two safeguards, plus a glanceable signal for you:
  - The `SessionStart` hook emits a directive to arm the watcher; the `UserPromptSubmit` hook scans `/proc` for a live watcher bound to the session and **re-nudges every prompt until one exists** (self-terminating; disable with `CKN_WATCHER_NUDGE=off`).
  - **Statusline indicator (recommended).** Add a bus segment to your Claude Code statusline so watcher state is visible at a glance — green `● bus` when armed, red `● bus off` when not. See "Statusline bus indicator" below.

#### Statusline bus indicator

The watcher's presence is worth surfacing in your statusline so you notice instantly when a session is *deaf between turns* — green `● bus` when armed, red `● bus off` when not.

**This is an opt-in addition to *your* statusline.** Your statusline is personal config: Cortex ships no statusline file and never writes the `statusLine` settings key. The full guide — the snippet, a setup prompt for an installing LLM (add *only* the dot to your existing script, never replace it), and manual breakout — is **[statusline-bus-dot](../statusline-bus-dot.md)**. The core of it: read `.session_id` from the statusline JSON and scan `/proc` for a matching `ckn-bus watch` (mirrors the hook's detection):

```bash
# In ~/.claude/statusline.sh — input is the statusline JSON on stdin.
SESSION_ID=$(echo "$input" | jq -r '.session_id // empty')
bus_watcher_armed() {
  local sid="$1" pid cmd
  [ -z "$sid" ] && return 1
  for pid in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' < "$pid/cmdline" 2>/dev/null) || continue
    case "$cmd" in *ckn-bus*watch*)
      case "$cmd" in *"$sid"*) return 0 ;; esac
      tr '\0' '\n' < "$pid/environ" 2>/dev/null | grep -q "^CLAUDE_CODE_SESSION_ID=$sid$" && return 0 ;;
    esac
  done
  return 1
}
bus_watcher_armed "$SESSION_ID" && BUS='\033[32m● bus\033[0m' || BUS='\033[31m● bus off\033[0m'
# …then include $BUS in your printf status line.
```

Arming it (what the directive/nudge tells the model to run) is a persistent Monitor task with:
`cd <cortex> && CLAUDE_CODE_SESSION_ID=<sid> npx tsx bin/ckn-bus.ts watch` (or just `ckn-bus watch` once the alias is installed). The watcher talks only to the local server — cross-machine delivery is handled server-side by the mesh tier, so the watcher needs no mesh config of its own.

**Trust model (load-bearing).** Peer messages are *surfaced, not executed.* They are injected wrapped in an `<inter-session-message>` marker, analogous to shared-mind's `<shared-mind-content>` convention — untrusted peer content the human or session decides what to do with. This is deliberate: the bus is a coordination layer for human-touched sessions, not an autonomous orchestrator. Auto-acting on directives would convert it into automation running on interactive seats, which crosses the billing/terms boundary.

**CLI.** The `ckn-bus` command is **API-only** (the Cortex server must be running; it exits non-zero if it isn't):

| Subcommand | Purpose |
|---|---|
| `ckn-bus whoami` | Show this session's friendly name, id, and presence state. |
| `ckn-bus peers` | List all registered sessions with name, status, and last-seen. |
| `ckn-bus inbox` | Show undelivered (and recent) messages addressed to this session. |
| `ckn-bus send --to <name> --body "…"` | Send a message. `--to` accepts a friendly name, session id, or `*`. |
| `ckn-bus reply --ref <id> --to <name> --body "…"` | Reply to a message, threading by reference id. |
| `ckn-bus ack --id <id> [--done]` | Acknowledge a message (or mark it done). |
| `ckn-bus watch` | Stream inbound messages in real time (~1 s delivery). Arm via the Monitor tool for background operation; surface its state in your statusline (see "Statusline bus indicator"). |

The `/cortex-bus` slash command is also installed as a shorthand.

**Identity resolution.** `ckn-bus` resolves *which* session it's running as in this order: an explicit `--session`/`--from` flag → the `CLAUDE_CODE_SESSION_ID` environment variable (exported by Claude Code, authoritative regardless of cwd) → a fallback that picks the most-recent transcript under the current cwd's project dir. The env path means the CLI identifies the right session even after the model has `cd`'d into a subdirectory.

**No new hooks, no new env vars.** Bus logic folds into the three existing hook scripts: `ckn-context` (registers presence on SessionStart), `ckn-pause-context` (re-asserts presence via a self-healing heartbeat **and** delivers the inbox on UserPromptSubmit), and `ckn-extract` (signs off on SessionEnd).


Cross-machine delivery is the mesh tier — see [mesh](mesh.md); the watcher needs no mesh config of its own.

Related: [[cortex-coordination-overview]] · [[cortex-mesh]] · [[cortex-trust]]
